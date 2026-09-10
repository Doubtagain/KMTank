// Headless smoke test: joins casual, drives the tank, verifies snapshots.
import WebSocket from 'ws';
import {
  ACT_AUTOFIRE, MOVE_RIGHT, MOVE_DOWN, encodeInput, decodeSnapshot,
} from '@kmtank/shared';

const url = process.argv[2] ?? 'ws://127.0.0.1:8080/ws';
const ws = new WebSocket(url);

let snapshots = 0;
let seq = 0;
let lastSelf = null;
const kinds = { tank: 0, bullet: 0, shape: 0 };
const jsonTypes = new Map();
let firstBytes = 0;
let totalBytes = 0;
let movedFrom = null;

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'join', mode: 'casual', name: 'SmokeBot' }));
  setInterval(() => {
    ws.send(encodeInput({ seq: seq++, move: MOVE_RIGHT | MOVE_DOWN, actions: ACT_AUTOFIRE, aim: 0.7 }));
  }, 50);
});

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString());
    jsonTypes.set(msg.t, (jsonTypes.get(msg.t) ?? 0) + 1);
    if (msg.t === 'welcome') console.log('welcome:', JSON.stringify(msg.you), 'room', msg.roomId);
    if (msg.t === 'error') console.log('ERROR:', msg.code, msg.message);
    if (msg.t === 'killed') console.log('killed by', msg.killerName, 'score', msg.score);
    return;
  }
  const snap = decodeSnapshot(new Uint8Array(data));
  if (!snap) { console.log('DECODE FAILED'); return; }
  snapshots++;
  totalBytes += data.length;
  if (snapshots === 1) firstBytes = data.length;
  lastSelf = snap.self;
  const me = snap.entities.find((e) => e.kind === 0 && e.id === snap.self.id);
  if (me && !movedFrom) movedFrom = { x: me.x, y: me.y };
  for (const e of snap.entities) kinds[['tank', 'bullet', 'shape'][e.kind]]++;
});

setTimeout(() => {
  console.log('--- results after 8s ---');
  console.log('snapshots:', snapshots, '(expect ~160 at 20Hz)');
  console.log('avg snapshot bytes:', Math.round(totalBytes / Math.max(1, snapshots)));
  console.log('entity samples:', kinds);
  console.log('json messages:', Object.fromEntries(jsonTypes));
  console.log('self:', JSON.stringify(lastSelf));
  const ok = snapshots > 100 && kinds.tank > 0 && kinds.shape > 0 && kinds.bullet > 0 && lastSelf?.score > 0;
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
}, 8000);
