import type { IncomingMessage, Server } from 'node:http';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  CLIENT_TIMEOUT_MS,
  PING_INTERVAL_MS,
  decodeInput,
  type ClientMessage,
} from '@kmtank/shared';

import { config } from '../config.js';
import { AuthError, sanitizeName, verifySessionToken } from '../auth/index.js';
import { getStore } from '../db/store.js';
import { matchmaker } from '../match/matchmaker.js';
import { Connection } from './connection.js';

const MAX_TEXT_FRAME = 8 * 1024;

function originAllowed(req: IncomingMessage): boolean {
  if (config.corsOrigins.includes('*')) return true;
  const origin = req.headers.origin;
  // Non-browser clients omit Origin entirely; only browsers are restricted.
  if (!origin) return true;
  return config.corsOrigins.includes(origin);
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function attachGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const connections = new Set<Connection>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const connection = new Connection(socket, clientIp(req));
    connections.add(connection);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      connection.lastSeenAt = Date.now();
      try {
        if (isBinary) handleBinary(connection, data);
        else void handleText(connection, data);
      } catch (error) {
        console.error('[ws] message handling failed', error);
      }
    });

    socket.on('pong', () => {
      connection.lastSeenAt = Date.now();
    });

    socket.on('close', () => {
      connection.alive = false;
      matchmaker.leave(connection);
      connections.delete(connection);
    });

    socket.on('error', () => {
      connection.alive = false;
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of connections) {
      if (now - connection.lastSeenAt > CLIENT_TIMEOUT_MS) {
        connection.close(1001, 'timeout');
        continue;
      }
      connection.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

function handleBinary(connection: Connection, data: RawData): void {
  if (!connection.joined || !connection.room) return;
  if (!connection.allow('input')) return;
  const buffer = toUint8(data);
  if (!buffer) return;
  const frame = decodeInput(buffer);
  if (!frame) return;
  connection.room.setInput(connection.tankId, frame.move, frame.actions, frame.aim);
}

function toUint8(data: RawData): Uint8Array | null {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return null;
}

async function handleText(connection: Connection, data: RawData): Promise<void> {
  if (!connection.allow('control')) return;
  const text = data.toString();
  if (text.length > MAX_TEXT_FRAME) return;

  let message: ClientMessage;
  try {
    message = JSON.parse(text) as ClientMessage;
  } catch {
    return;
  }
  if (!message || typeof message.t !== 'string') return;

  switch (message.t) {
    case 'join':
      await handleJoin(connection, message);
      return;

    case 'upgradeStat':
      if (connection.room && Number.isInteger(message.stat)) {
        connection.room.upgradeStat(connection.tankId, message.stat);
      }
      return;

    case 'upgradeClass':
      if (connection.room && typeof message.classKey === 'string') {
        connection.room.upgradeClass(connection.tankId, message.classKey);
      }
      return;

    case 'respawn':
      connection.room?.requestRespawn(connection.tankId);
      return;

    case 'leave':
      matchmaker.leave(connection);
      return;

    case 'ping':
      connection.sendJson({ t: 'pong', at: Number(message.at) || 0, serverTime: Date.now() });
      return;

    default:
      return;
  }
}

async function handleJoin(connection: Connection, message: ClientMessage & { t: 'join' }): Promise<void> {
  if (connection.joined) return;

  const mode = message.mode === 'ranked' ? 'ranked' : 'casual';

  if (typeof message.token === 'string' && message.token.length > 0) {
    try {
      const claims = verifySessionToken(message.token);
      const user = await getStore().getUser(claims.sub);
      if (!user) throw new AuthError('Account no longer exists');
      connection.userId = user.id;
      connection.name = user.name;
      connection.mmr = user.mmr;
      connection.rankedMatches = user.matches;
    } catch (error) {
      connection.sendJson({
        t: 'error',
        code: 'invalid_token',
        message: error instanceof Error ? error.message : 'Sign-in expired, please sign in again',
      });
      return;
    }
  } else {
    connection.userId = null;
    connection.name = sanitizeName(typeof message.name === 'string' ? message.name : 'Player');
  }

  if (mode === 'ranked' && !connection.userId) {
    connection.sendJson({
      t: 'error',
      code: 'auth_required',
      message: 'Sign in with Google to play ranked.',
    });
    return;
  }

  connection.joined = true;
  if (mode === 'ranked') matchmaker.enqueueRanked(connection);
  else matchmaker.joinCasual(connection);
}
