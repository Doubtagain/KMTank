# Deploying KMTank

Target: **$0/month**. Three pieces — a static client, a long-lived game server,
and a Postgres database — each on a provider with a real free tier.

```
Cloudflare Pages ──HTTPS──▶ Render / Fly.io ──▶ Neon Postgres
   (client)         + WSS      (game server)      (accounts, MMR)
```

---

## 1. Database — Neon (free)

Neon's free tier gives 0.5 GB and autosuspends when idle, which is plenty for
accounts and ratings.

1. Create a project at <https://neon.tech>.
2. Copy the pooled connection string. It looks like
   `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`.
3. Keep it for step 3 — you do **not** need to run any migration. The server
   applies `packages/server/src/db/schema.sql` on boot, and the file is written
   to be safe to re-run.

Supabase's free Postgres works identically; use its connection string instead.

> Skipping this step is supported. Without `DATABASE_URL` the server keeps
> accounts and ratings in memory, which is fine for a demo but means every
> restart wipes the ladder. The menu tells players when this is the case.

---

## 2. Google sign-in

Ranked play requires an account, and accounts come from Google.

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. **Create credentials → OAuth client ID → Web application.**
3. Under **Authorised JavaScript origins**, add every origin the *client* is
   served from:
   - `http://localhost:5173` (local dev)
   - `https://kmtank.pages.dev` (or your Pages/Vercel domain)
   - your custom domain, if any
4. You do **not** need a redirect URI. KMTank uses Google Identity Services,
   which hands the browser an ID token directly.
5. Copy the **Client ID** (`…apps.googleusercontent.com`).

The client id is public by design — it identifies the site, it does not
authorise anything. The client *secret* is not used and should not be set.

---

## 3. Server — Render (free) or Fly.io

### Option A: Render

Truly free, no card. The trade-off is that the instance sleeps after ~15 minutes
without traffic and takes 30–60 seconds to wake.

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, select the repo. It reads `render.yaml`.
3. Render will prompt for the values marked `sync: false`:
   - `GOOGLE_CLIENT_ID` — from step 2
   - `DATABASE_URL` — from step 1
   - `CORS_ORIGINS` — your client origin, e.g. `https://kmtank.pages.dev`
     (comma-separated if more than one; no trailing slash)
4. `JWT_SECRET` is generated for you. Leave it alone — rotating it signs
   everyone out.
5. Deploy, then confirm `https://<your-service>.onrender.com/health` returns
   `{"ok":true,...}`.

Change `region: singapore` in `render.yaml` to whichever of Render's regions is
closest to your players; latency matters more than anything else here.

### Option B: Fly.io

Keeps a machine warm, so no cold starts. A single `shared-cpu-1x` 256 MB machine
sits inside the monthly trial credit, but Fly does require a card on file.

```bash
fly launch --no-deploy --copy-config
fly secrets set \
  JWT_SECRET="$(openssl rand -base64 48)" \
  GOOGLE_CLIENT_ID="...apps.googleusercontent.com" \
  DATABASE_URL="postgresql://..." \
  CORS_ORIGINS="https://kmtank.pages.dev"
fly deploy
```

Set `primary_region` in `fly.toml` to a region near your players (`nrt` Tokyo,
`iad` Virginia, `fra` Frankfurt, …).

### WebSockets

Both providers proxy WebSockets on the same origin as HTTP with no extra
configuration, so `wss://<server-host>/ws` works once the service is up. There
is nothing to open or forward.

---

## 4. Client — Cloudflare Pages (free)

Unlimited bandwidth on the free plan, which is the right shape for a game that
serves a small bundle to many people.

1. **Workers & Pages → Create → Pages → Connect to Git**, select the repo.
2. Build settings:
   - **Framework preset**: None
   - **Build command**:
     `npm run build -w @kmtank/shared && npm run build -w @kmtank/client`
   - **Build output directory**: `packages/client/dist`
   - **Root directory**: leave empty (the monorepo root)
3. Environment variables (Production **and** Preview):
   - `VITE_SERVER_URL` = `https://<your-service>.onrender.com` — no trailing
     slash. This is baked in at build time, so changing it needs a rebuild.
   - `NODE_VERSION` = `22`
4. Deploy.

Vercel works the same way and reads the included `vercel.json`; set
`VITE_SERVER_URL` in its project settings.

### Closing the loop

After the client is live, go back and make sure:

- the client's origin is in the server's `CORS_ORIGINS`, and
- the same origin is in the Google OAuth client's authorised origins.

Both are exact-match on scheme + host + port. `https://kmtank.pages.dev` and
`https://kmtank.pages.dev/` are not the same string; drop the trailing slash.

---

## Single-origin alternative

You can also serve the client from the game server and skip Pages entirely, at
the cost of losing the CDN. Build the client, then put any static file server in
front of `packages/client/dist` on the same host. With client and server sharing
an origin, `VITE_SERVER_URL` can be left unset — the client defaults to
`window.location.origin`.

---

## Verifying a deployment

```bash
BASE=https://<your-service>.onrender.com

curl -s $BASE/health
# {"ok":true,"service":"kmtank","season":1}

curl -s $BASE/api/config
# googleEnabled and durableRanks should both be true

curl -s $BASE/api/stats
# {"rooms":1,"players":0,"queued":0}
```

Then open the client, sign in, and check that the account card shows your name
and `Placements 0/5`. If sign-in fails, the browser console will say whether
Google rejected the origin (fix step 2) or the server rejected the token (fix
`GOOGLE_CLIENT_ID` on the server — it must be the *same* client id).

## Operating notes

- **Seasons.** Bump `SEASON` to start a fresh ladder. Old rows are kept; the
  leaderboard and every rating lookup are scoped to the current season.
- **Scaling.** One Node process holds all rooms in memory. A 256 MB instance
  handles a few hundred concurrent players comfortably. Beyond that you would
  need a room directory shared between processes — the `Matchmaker` is the seam
  where that would go.
- **Cost ceiling.** Nothing here autoscales or bills per request. The failure
  mode of a traffic spike is refused connections, not a bill.
