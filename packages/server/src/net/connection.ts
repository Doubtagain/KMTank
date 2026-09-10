import type { WebSocket } from 'ws';
import { STARTING_MMR, type GameMode, type ServerMessage } from '@kmtank/shared';

import type { Room, RoomClient } from '../game/room.js';

let nextConnectionId = 1;

/** A single browser socket. Lives longer than any one room membership. */
export class Connection implements RoomClient {
  readonly id = `c${nextConnectionId++}`;

  /** Entity id inside the current room, or 0 when not playing. */
  tankId = 0;
  room: Room | null = null;
  mode: GameMode = 'casual';

  userId: string | null = null;
  name = 'Player';
  mmr = STARTING_MMR;
  rankedMatches = 0;

  /** Set once the socket has sent a valid `join`. */
  joined = false;
  alive = true;
  lastSeenAt = Date.now();

  /** Sliding-window counters used to shed abusive clients. */
  private inputCount = 0;
  private controlCount = 0;
  private windowStartedAt = Date.now();

  constructor(
    private readonly socket: WebSocket,
    readonly ip: string,
  ) {}

  sendJson(message: ServerMessage): void {
    this.send(JSON.stringify(message), false);
  }

  sendBinary(data: Uint8Array): void {
    this.send(data, true);
  }

  private send(payload: string | Uint8Array, binary: boolean): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    // Drop state updates rather than queue them for a client that cannot keep
    // up; a stale snapshot is worse than a skipped one.
    if (binary && this.socket.bufferedAmount > 512 * 1024) return;
    this.socket.send(payload, { binary });
  }

  /** Liveness probe; the browser answers with a pong frame automatically. */
  ping(): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.ping();
    } catch {
      // The socket is closing; the heartbeat will reap it next pass.
    }
  }

  close(code = 1000, reason = 'closed'): void {
    this.alive = false;
    try {
      this.socket.close(code, reason);
    } catch {
      // The socket is already gone; nothing to do.
    }
  }

  /**
   * Rate limiter. Returns false when the client is over budget for the
   * current one-second window and the message should be dropped.
   */
  allow(kind: 'input' | 'control'): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= 1000) {
      this.windowStartedAt = now;
      this.inputCount = 0;
      this.controlCount = 0;
    }
    if (kind === 'input') {
      this.inputCount += 1;
      return this.inputCount <= 90;
    }
    this.controlCount += 1;
    return this.controlCount <= 40;
  }
}
