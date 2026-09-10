/**
 * Drives a full ranked match with N scripted clients.
 *
 * Requires the server to be started with ALLOW_DEV_LOGIN=1 (dev only) so the
 * clients can obtain sessions without Google.
 *
 *   node tools/ranked-sim.mjs [playerCount] [httpBase]
 */
import WebSocket from 'ws';
import { ACT_AUTOFIRE, MOVE_DOWN, MOVE_LEFT, MOVE_RIGHT, MOVE_UP, encodeInput, decodeSnapshot } from '@kmtank/shared';

const count = Number(process.argv[2] ?? 4);
const http = process.argv[3] ?? 'http://127.0.0.1:8080';
const ws = `${http.replace(/^http/, 'ws')}/ws`;

const MOVES = [MOVE_UP | MOVE_RIGHT, MOVE_DOWN | MOVE_RIGHT, MOVE_DOWN | MOVE_LEFT, MOVE_UP | MOVE_LEFT];

async function login(name) {
  const response = await fetch(`${http}/api/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`dev login failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function play(name, token, index) {
  return new Promise((resolve) => {
    const socket = new WebSocket(ws);
    const log = [];
    let seq = 0;
    let joined = false;
    let result = null;
    let lastScore = 0;

    socket.on('open', () => socket.send(JSON.stringify({ t: 'join', mode: 'ranked', token })));

    const drive = setInterval(() => {
      if (!joined) return;
      const phase = Math.floor(Date.now() / 2500 + index) % 4;
      socket.send(encodeInput({ seq: seq++, move: MOVES[phase], actions: ACT_AUTOFIRE, aim: (Date.now() / 700 + index) % 6.28 }));
    }, 50);

    // Respawn promptly so every client keeps scoring.
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const snap = decodeSnapshot(new Uint8Array(data));
        if (snap) lastScore = snap.self.score;
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.t === 'welcome') { joined = true; log.push(`welcome room=${msg.roomId}`); }
      else if (msg.t === 'queue') log.push(`queue size=${msg.size} needed=${msg.needed} startsIn=${msg.startsIn}`);
      else if (msg.t === 'killed') setTimeout(() => socket.send(JSON.stringify({ t: 'respawn' })), 2200);
      else if (msg.t === 'error') log.push(`ERROR ${msg.code}: ${msg.message}`);
      else if (msg.t === 'match' && msg.phase === 'ended') log.push('match ended');
      else if (msg.t === 'result') {
        result = msg;
        clearInterval(drive);
        socket.close();
        resolve({ name, log, result, lastScore });
      }
    });

    socket.on('close', () => { clearInterval(drive); if (!result) resolve({ name, log, result: null, lastScore }); });
    socket.on('error', (err) => { clearInterval(drive); resolve({ name, log: [...log, `socket error: ${err.message}`], result: null, lastScore }); });
  });
}

const sessions = [];
for (let i = 0; i < count; i++) sessions.push(await login(`Sim${i + 1}`));
console.log(`logged in ${sessions.length} players`);
for (const s of sessions) console.log(`  ${s.user.name}: ${s.user.mmr} MMR, ${s.user.rankLabel}`);

const outcomes = await Promise.all(sessions.map((s, i) => play(s.user.name, s.token, i)));

console.log('\n--- per-client log ---');
for (const outcome of outcomes) console.log(outcome.name, '::', outcome.log.join(' | '));

const withResult = outcomes.find((o) => o.result);
if (!withResult) {
  console.log('\nNO RESULT RECEIVED');
  process.exit(1);
}
console.log('\n--- scoreboard ---');
for (const row of withResult.result.rows) {
  const delta = row.mmrDelta === null ? '--' : `${row.mmrDelta > 0 ? '+' : ''}${row.mmrDelta}`;
  console.log(
    `#${row.placement}  ${row.name.padEnd(10)} score=${String(row.score).padStart(6)} kills=${row.kills}  ` +
    `${row.mmrBefore} -> ${row.mmrAfter} (${delta})  ${row.rankLabel ?? ''}`,
  );
}

const board = await (await fetch(`${http}/api/leaderboard?limit=10`)).json();
console.log('\n--- persisted ladder ---');
console.log(board.rows.length ? board.rows.map((r) => `#${r.rank} ${r.name} ${r.mmr} ${r.rankLabel} (${r.rankedMatches} matches)`).join('\n') : '(still in placements, nothing listed)');

const me = await (await fetch(`${http}/api/me`, { headers: { Authorization: `Bearer ${sessions[0].token}` } })).json();
console.log('\n--- /api/me after the match ---');
console.log(JSON.stringify(me));
