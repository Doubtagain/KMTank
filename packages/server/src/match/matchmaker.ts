import {
  DT,
  RANKED_MAX_PLAYERS,
  RANKED_MIN_PLAYERS,
  TICK_RATE,
  WORLD_SIZE,
  rankFor,
  type GameMode,
} from '@kmtank/shared';

import { config } from '../config.js';
import { Room, type Participant } from '../game/room.js';
import type { Connection } from '../net/connection.js';
import { settleRankedMatch } from './rating.js';

interface QueueEntry {
  connection: Connection;
  queuedAt: number;
}

let roomCounter = 1;

/**
 * Owns every room and the ranked queue, and drives the single fixed-timestep
 * loop that all rooms share.
 */
export class Matchmaker {
  private readonly rooms = new Map<string, Room>();
  private readonly rankedQueue: QueueEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastTickAt = 0;
  /** Wall-clock ms at which the ranked lobby will start regardless of size. */
  private queueDeadline: number | null = null;

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    // Run the interval a little faster than the tick rate and use an
    // accumulator, so timer jitter does not slow the simulation down.
    this.timer = setInterval(() => this.pump(), Math.floor(1000 / TICK_RATE / 2));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private pump(): void {
    const now = Date.now();
    let elapsed = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    // A long stall (GC pause, laptop sleep) must not trigger a catch-up storm.
    if (elapsed > 0.5) elapsed = 0.5;
    this.accumulator += elapsed;

    let steps = 0;
    while (this.accumulator >= DT && steps < 5) {
      this.accumulator -= DT;
      steps++;
      for (const room of this.rooms.values()) {
        try {
          room.step();
        } catch (error) {
          console.error(`[room ${room.id}] step failed`, error);
        }
      }
    }

    this.serviceRankedQueue(now);
  }

  // -------------------------------------------------------------------------
  // Casual
  // -------------------------------------------------------------------------

  joinCasual(connection: Connection): Room {
    let target: Room | undefined;
    for (const room of this.rooms.values()) {
      if (room.mode !== 'casual' || room.isFull) continue;
      // Prefer the busiest room that still has space, so players meet.
      if (!target || room.humanCount > target.humanCount) target = room;
    }
    if (!target) target = this.createRoom('casual');
    this.seat(connection, target);
    return target;
  }

  // -------------------------------------------------------------------------
  // Ranked
  // -------------------------------------------------------------------------

  enqueueRanked(connection: Connection): void {
    if (this.rankedQueue.some((entry) => entry.connection === connection)) return;
    this.rankedQueue.push({ connection, queuedAt: Date.now() });
    connection.mode = 'ranked';
    this.broadcastQueueState();
  }

  dequeue(connection: Connection): void {
    const index = this.rankedQueue.findIndex((entry) => entry.connection === connection);
    if (index >= 0) {
      this.rankedQueue.splice(index, 1);
      if (this.rankedQueue.length < RANKED_MIN_PLAYERS) this.queueDeadline = null;
      this.broadcastQueueState();
    }
  }

  private serviceRankedQueue(now: number): void {
    // Drop anyone whose socket died while waiting.
    for (let i = this.rankedQueue.length - 1; i >= 0; i--) {
      if (!this.rankedQueue[i].connection.alive) this.rankedQueue.splice(i, 1);
    }

    if (this.rankedQueue.length < RANKED_MIN_PLAYERS) {
      if (this.queueDeadline !== null) {
        this.queueDeadline = null;
        this.broadcastQueueState();
      }
      return;
    }

    if (this.queueDeadline === null) {
      this.queueDeadline = now + config.rankedQueueGrace * 1000;
      this.broadcastQueueState();
    }

    const full = this.rankedQueue.length >= RANKED_MAX_PLAYERS;
    if (!full && now < this.queueDeadline) return;

    this.launchRankedMatch();
  }

  private launchRankedMatch(): void {
    // Group the closest ratings together so a lobby is competitive.
    const sorted = [...this.rankedQueue].sort((a, b) => a.connection.mmr - b.connection.mmr);
    const take = Math.min(RANKED_MAX_PLAYERS, sorted.length);
    const chosen = sorted.slice(0, take);

    // Remove all of them before seating anyone, so the players left waiting see
    // one corrected queue state rather than one per seat.
    for (const entry of chosen) {
      const index = this.rankedQueue.indexOf(entry);
      if (index >= 0) this.rankedQueue.splice(index, 1);
    }
    const room = this.createRoom('ranked');
    for (const entry of chosen) this.seat(entry.connection, room);

    this.queueDeadline = null;
    this.broadcastQueueState();
    console.log(`[matchmaker] ranked match ${room.id} started with ${chosen.length} players`);
  }

  private broadcastQueueState(): void {
    const size = this.rankedQueue.length;
    const startsIn =
      this.queueDeadline === null ? null : Math.max(0, Math.round((this.queueDeadline - Date.now()) / 1000));
    this.rankedQueue.forEach((entry, index) => {
      entry.connection.sendJson({
        t: 'queue',
        mode: 'ranked',
        position: index + 1,
        size,
        needed: Math.max(0, RANKED_MIN_PLAYERS - size),
        startsIn,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  private createRoom(mode: GameMode): Room {
    const room = new Room({
      id: `${mode[0]}${roomCounter++}`,
      mode,
      botTarget: config.botsEnabled ? config.botTarget : 0,
      onMatchEnd: (finished, participants) => {
        void this.handleMatchEnd(finished, participants);
      },
      onEmpty: (empty) => {
        // Casual rooms are cheap to keep warm briefly; ranked rooms with no
        // players left have nothing to simulate.
        if (empty.mode === 'ranked') empty.abortMatch();
      },
    });
    this.rooms.set(room.id, room);
    return room;
  }

  private seat(connection: Connection, room: Room): void {
    const tank = room.addPlayer(connection.name, connection.userId);
    connection.tankId = tank.id;
    connection.room = room;
    connection.mode = room.mode;
    room.attachClient(connection);

    const rank = connection.userId ? rankFor(connection.mmr, connection.rankedMatches) : null;
    connection.sendJson({
      t: 'welcome',
      playerId: tank.id,
      mode: room.mode,
      roomId: room.id,
      tickRate: TICK_RATE,
      worldSize: WORLD_SIZE,
      serverTime: Date.now(),
      you: {
        id: tank.id,
        name: connection.name,
        userId: connection.userId,
        classKey: tank.classKey,
        level: tank.level,
        score: 0,
        colorIndex: tank.colorIndex,
        mmr: connection.userId ? connection.mmr : null,
        rankLabel: rank ? rank.label : null,
        bot: false,
      },
    });
    room.broadcast(room.rosterMessage());
  }

  leave(connection: Connection): void {
    this.dequeue(connection);
    const room = connection.room;
    if (!room) return;
    room.removePlayer(connection.tankId);
    connection.room = null;
    connection.tankId = 0;
    connection.joined = false;
    room.broadcast(room.rosterMessage());
    this.reapEmptyRooms();
  }

  private reapEmptyRooms(): void {
    for (const [id, room] of this.rooms) {
      if (room.humanCount > 0) continue;
      if (room.mode === 'casual' && this.countRooms('casual') <= 1) continue;
      this.rooms.delete(id);
    }
  }

  private countRooms(mode: GameMode): number {
    let n = 0;
    for (const room of this.rooms.values()) if (room.mode === mode) n++;
    return n;
  }

  private async handleMatchEnd(room: Room, participants: Participant[]): Promise<void> {
    try {
      await settleRankedMatch(room, participants);
    } catch (error) {
      console.error('[matchmaker] failed to settle ranked match', error);
    } finally {
      // Give clients a moment to read the scoreboard before tearing the room down.
      setTimeout(() => {
        for (const client of [...room.clients.values()]) {
          const connection = client as Connection;
          connection.room = null;
          connection.tankId = 0;
          connection.joined = false;
        }
        room.clients.clear();
        this.rooms.delete(room.id);
      }, 15_000).unref?.();
    }
  }

  stats(): { rooms: number; players: number; queued: number } {
    let players = 0;
    for (const room of this.rooms.values()) players += room.humanCount;
    return { rooms: this.rooms.size, players, queued: this.rankedQueue.length };
  }
}

export const matchmaker = new Matchmaker();
