import type { IncomingMessage, ServerResponse } from 'node:http';

import { PLACEMENT_MATCHES, TIERS, type AuthResponse } from '@kmtank/shared';

import { config } from '../config.js';
import {
  AuthError,
  issueSessionToken,
  loginWithGoogle,
  sanitizeName,
  verifySessionToken,
} from '../auth/index.js';
import { getStore, toProfile } from '../db/store.js';
import { matchmaker } from '../match/matchmaker.js';

const MAX_BODY_BYTES = 64 * 1024;

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowAll = config.corsOrigins.includes('*');
  const allowed = allowAll || (origin !== undefined && config.corsOrigins.includes(origin));
  return {
    'Access-Control-Allow-Origin': allowAll ? '*' : allowed ? origin! : 'null',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...corsHeaders(req.headers.origin),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

/** Returns true when the request was handled. */
export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req.headers.origin));
    res.end();
    return true;
  }

  if (path === '/health' || path === '/') {
    sendJson(req, res, 200, { ok: true, service: 'kmtank', season: config.season });
    return true;
  }

  if (path === '/api/config' && req.method === 'GET') {
    sendJson(req, res, 200, {
      googleClientId: config.googleClientId || null,
      googleEnabled: Boolean(config.googleClientId),
      season: config.season,
      durableRanks: getStore().durable,
      placementMatches: PLACEMENT_MATCHES,
      tiers: TIERS,
    });
    return true;
  }

  if (path === '/api/stats' && req.method === 'GET') {
    sendJson(req, res, 200, matchmaker.stats());
    return true;
  }

  if (path === '/api/auth/google' && req.method === 'POST') {
    try {
      const body = (await readJsonBody(req)) as { credential?: unknown };
      if (typeof body.credential !== 'string') {
        sendJson(req, res, 400, { error: 'credential is required' });
        return true;
      }
      const user = await loginWithGoogle(body.credential);
      const response: AuthResponse = {
        token: issueSessionToken(user),
        user: toProfile(user),
      };
      sendJson(req, res, 200, response);
    } catch (error) {
      if (error instanceof AuthError) {
        sendJson(req, res, error.code === 'not_configured' ? 503 : 401, {
          error: error.message,
          code: error.code,
        });
      } else {
        console.error('[http] google login failed', error);
        sendJson(req, res, 500, { error: 'login failed' });
      }
    }
    return true;
  }

  if (path === '/api/auth/dev' && req.method === 'POST') {
    // Deliberately unavailable in production, whatever the env var says.
    if (config.isProduction || !config.allowDevLogin) {
      sendJson(req, res, 404, { error: 'not found' });
      return true;
    }
    const body = (await readJsonBody(req)) as { name?: unknown };
    const name = sanitizeName(typeof body.name === 'string' ? body.name : 'DevPlayer');
    // A stable pseudo-subject so repeated logins reuse the same account.
    const user = await getStore().upsertGoogleUser({
      sub: `dev:${name.toLowerCase()}`,
      email: null,
      name,
      picture: null,
    });
    const response: AuthResponse = { token: issueSessionToken(user), user: toProfile(user) };
    sendJson(req, res, 200, response);
    return true;
  }

  if (path === '/api/me' && req.method === 'GET') {
    const token = bearerToken(req);
    if (!token) {
      sendJson(req, res, 401, { error: 'missing bearer token' });
      return true;
    }
    try {
      const claims = verifySessionToken(token);
      const user = await getStore().getUser(claims.sub);
      if (!user) {
        sendJson(req, res, 404, { error: 'user not found' });
        return true;
      }
      sendJson(req, res, 200, toProfile(user));
    } catch (error) {
      sendJson(req, res, 401, { error: error instanceof Error ? error.message : 'unauthorized' });
    }
    return true;
  }

  if (path === '/api/leaderboard' && req.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    try {
      const rows = await getStore().leaderboard(limit, offset);
      sendJson(req, res, 200, { season: config.season, rows });
    } catch (error) {
      console.error('[http] leaderboard failed', error);
      sendJson(req, res, 500, { error: 'leaderboard unavailable' });
    }
    return true;
  }

  return false;
}

export function sendNotFound(req: IncomingMessage, res: ServerResponse): void {
  sendJson(req, res, 404, { error: 'not found' });
}
