# KMTank

A realtime browser tank arena in the spirit of diep.io — server-authoritative,
with Google sign-in and a ranked ladder on top.

한국어 문서: [README.ko.md](README.ko.md)

```
Farm shapes → level up → pick a build → outlive everyone.
```

## What's here

- **Authoritative simulation.** The server owns every position, every hit and
  every point of XP. Clients send 9-byte input frames and receive binary world
  snapshots; nothing about the game state is decided in the browser.
- **20 Hz tick, interpolated rendering.** Clients render 110 ms in the past and
  interpolate between snapshots, while the local tank runs the same movement
  model client-side for input that responds on the frame you press a key.
- **26 tank classes across four tiers.** Basic → Twin / Sniper / Machine Gun /
  Flank Guard at level 15, another branch at 30, and a final one at 45. A class
  is nothing but a list of barrels, so the simulation has no per-class code.
- **8 upgradable stats**, 7 points each, on the diep.io curve.
- **Ranked ladder.** Google sign-in, MMR by multiplayer Elo, 5 placement
  matches, then 8 tiers from Bronze III to Challenger, with seasons.
- **AI opponents** so a quiet arena is never empty. Bots drive the same input
  struct as players and are capped so they can't wall off new players.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shared | TypeScript, no runtime deps | Constants, tank tree, rating math and the wire codec are compiled once and imported by both sides, so client and server cannot drift |
| Server | Node 22, `ws`, `node:http` | One fixed-timestep loop drives every room; no framework needed for six routes |
| Database | Postgres via `pg` | Falls back to an in-memory store when `DATABASE_URL` is unset, so `npm run dev` needs no setup |
| Auth | Google Identity Services → `google-auth-library` → own JWT | The ID token is verified against our client id server-side; the browser never holds a long-lived Google credential |
| Client | Vite + TypeScript + Canvas 2D | 15 KB gzipped, no framework, no build-time asset pipeline |

## Quick start

```bash
npm install
npm run dev
```

That builds the shared package, starts the game server on `:8080` and the client
on `:5173`. Open http://localhost:5173 and hit **Play Casual** — no database, no
Google client id and no configuration are needed to play.

For ranked locally, add `ALLOW_DEV_LOGIN=1` to `.env` and use the
`POST /api/auth/dev` endpoint (see [Testing](#testing)), or set up a real
`GOOGLE_CLIENT_ID`.

### Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim |
| Click / `Space` | Shoot |
| `E` | Toggle autofire |
| `C` | Toggle autospin |
| `1`–`8` | Spend a stat point |

Touch is supported: drag on the left half of the screen to move, on the right
half to aim and fire.

## Configuration

Every setting lives in [`.env.example`](.env.example). The ones that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | dev placeholder | **Set this in production.** Signs session tokens |
| `GOOGLE_CLIENT_ID` | empty | Without it, ranked is unavailable and the menu says so |
| `DATABASE_URL` | empty | Without it, ranks live in memory and reset on restart |
| `CORS_ORIGINS` | `*` | Set to your client origin(s) in production |
| `BOT_TARGET` | `8` | AI tanks per casual room |
| `RANKED_MATCH_SECONDS` | `480` | Ranked match length |
| `RANKED_QUEUE_GRACE` | `30` | How long a partly-filled lobby waits |
| `VITE_SERVER_URL` | dev localhost | Client build-time pointer at the server |

## Deployment

Everything below has a genuinely free tier. See
[docs/DEPLOY.md](docs/DEPLOY.md) for step-by-step instructions.

- **Client** → Cloudflare Pages (build `npm run build -w @kmtank/shared && npm run build -w @kmtank/client`, output `packages/client/dist`). Vercel works too, via the included `vercel.json`.
- **Server** → Render (free, blueprint in `render.yaml`) or Fly.io (`fly.toml`). Both build the root `Dockerfile`.
- **Database** → Neon or Supabase Postgres. The schema is applied automatically on boot.

The one real caveat: Render's free instance sleeps after ~15 minutes idle, so
the first player after a quiet spell waits through a cold start. Fly's config
here keeps one machine warm instead.

## Repository layout

```
packages/
  shared/   constants, tank tree, stat curves, rating math, binary codec
  server/   simulation, matchmaking, auth, persistence, websocket gateway
  client/   canvas renderer, prediction, HUD, menus
tools/      headless clients used for smoke tests and ranked simulation
docs/       deployment guide
```

### How a frame flows

```
browser input ──9 bytes──▶ gateway ──▶ room.setInput()
                                          │
                          fixed 20 Hz loop │  move → shoot → collide → score
                                          ▼
browser ◀──binary snapshot── per-viewer culling (1150-unit radius)
   │
   └─ interpolate at T-110ms, draw local tank from prediction
```

## Testing

Two headless clients live in `tools/`:

```bash
# Join casual, drive around, assert snapshots decode and XP accrues
node tools/smoke-client.mjs

# Run a full ranked match with 4 scripted players and print the MMR settlement
# (requires the server started with ALLOW_DEV_LOGIN=1)
node tools/ranked-sim.mjs 4
```

`npm run typecheck` type-checks all three packages. CI runs both plus a Docker
build on every push.

## Design notes

**Why binary snapshots?** A busy view is ~200 entities. As JSON that is ~30 KB
per snapshot; quantised to u16 positions and angles it is ~1.1 KB, measured. At
20 Hz that is the difference between 600 KB/s and 22 KB/s per player.

**Why no client-side rollback?** Full prediction and reconciliation would mean
shipping the whole collision model to the browser and replaying inputs. Instead
the client predicts only its own drive velocity — the part that dominates
perceived latency — and eases toward the server position on each snapshot.
Collisions and knockback simply arrive as correction. It is a fraction of the
complexity for most of the benefit.

**Why is a tank class just barrels?** Every gameplay difference between Twin and
Octo Tank is expressible as barrel geometry, reload phase and per-bullet
multipliers. Keeping it declarative means adding a class is a data change, and
the client can draw and preview any class without knowing it exists.

**Why rate a player who disconnects?** Their score at the moment they left is
what gets ranked. Otherwise the optimal play when losing is to close the tab.

## Licence

MIT — see [LICENSE](LICENSE).
