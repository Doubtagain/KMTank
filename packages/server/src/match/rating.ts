import {
  computeRatingDeltas,
  rankFor,
  type MatchResultRow,
  type RatedResult,
} from '@kmtank/shared';

import { config } from '../config.js';
import { getStore, type MatchPlayerResult } from '../db/store.js';
import type { Room, Participant } from '../game/room.js';
import type { Connection } from '../net/connection.js';

/**
 * Turns a finished ranked match into MMR movement, persists it, and sends
 * every still-connected player their scoreboard.
 *
 * Players who disconnected mid-match are still rated on the score they had
 * when they left, so leaving early is never a way to dodge a loss.
 */
export async function settleRankedMatch(room: Room, participants: Participant[]): Promise<void> {
  if (room.mode !== 'ranked') return;

  const store = getStore();
  const rated = participants.filter((p) => p.userId);

  if (rated.length < 2) {
    broadcastResult(room, buildUnratedRows(rated));
    return;
  }

  // Highest score wins. Equal scores share a placement.
  const ordered = [...rated].sort((a, b) => b.score - a.score || b.kills - a.kills);
  const placements = new Map<string, number>();
  let placement = 0;
  let previousScore = Number.NaN;
  ordered.forEach((participant, index) => {
    if (participant.score !== previousScore) {
      placement = index + 1;
      previousScore = participant.score;
    }
    placements.set(participant.userId, placement);
  });

  const users = await Promise.all(ordered.map((p) => store.getUser(p.userId)));
  const inputs: RatedResult[] = [];
  ordered.forEach((participant, index) => {
    const user = users[index];
    if (!user) return;
    inputs.push({
      userId: participant.userId,
      mmr: user.mmr,
      placement: placements.get(participant.userId)!,
      matchesPlayed: user.matches,
    });
  });

  if (inputs.length < 2) {
    broadcastResult(room, buildUnratedRows(ordered));
    return;
  }

  const deltas = computeRatingDeltas(inputs);
  const deltaById = new Map(deltas.map((d) => [d.userId, d]));

  const persisted: MatchPlayerResult[] = [];
  const rows: MatchResultRow[] = [];

  for (const participant of ordered) {
    const delta = deltaById.get(participant.userId);
    const place = placements.get(participant.userId)!;
    if (delta) {
      persisted.push({
        userId: participant.userId,
        placement: place,
        score: participant.score,
        kills: participant.kills,
        deaths: participant.deaths,
        mmrBefore: delta.before,
        mmrAfter: delta.after,
      });
    }
    const index = inputs.findIndex((i) => i.userId === participant.userId);
    const matchesAfter = index >= 0 ? inputs[index].matchesPlayed + 1 : 0;
    rows.push({
      placement: place,
      name: participant.name,
      userId: participant.userId,
      score: participant.score,
      kills: participant.kills,
      mmrBefore: delta?.before ?? null,
      mmrAfter: delta?.after ?? null,
      mmrDelta: delta?.delta ?? null,
      rankLabel: delta ? rankFor(delta.after, matchesAfter).label : null,
      you: false,
    });
  }

  await store.recordMatch('ranked', config.rankedMatchSeconds, persisted);

  // Keep in-memory ratings in step so a rematch queues at the new MMR.
  for (const client of room.clients.values()) {
    const connection = client as Connection;
    if (!connection.userId) continue;
    const delta = deltaById.get(connection.userId);
    if (!delta) continue;
    connection.mmr = delta.after;
    connection.rankedMatches += 1;
  }

  broadcastResult(room, rows);
}

function buildUnratedRows(participants: Participant[]): MatchResultRow[] {
  return [...participants]
    .sort((a, b) => b.score - a.score)
    .map((participant, index) => ({
      placement: index + 1,
      name: participant.name,
      userId: participant.userId,
      score: participant.score,
      kills: participant.kills,
      mmrBefore: null,
      mmrAfter: null,
      mmrDelta: null,
      rankLabel: null,
      you: false,
    }));
}

/** Sends the scoreboard, marking each recipient's own row. */
function broadcastResult(room: Room, rows: MatchResultRow[]): void {
  for (const client of room.clients.values()) {
    const connection = client as Connection;
    const personalised = rows.map((row) => ({
      ...row,
      you: row.userId !== null && row.userId === connection.userId,
    }));
    connection.sendJson({ t: 'result', mode: 'ranked', rows: personalised });
  }
}
