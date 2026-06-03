# 中文新闻电台 — Audio Worker (public)

Minimal, **public** companion to the private `Radio_News` repo. It does one job:
turn already-written news scripts into spoken-Mandarin MP3s using
[Kokoro](https://github.com/hexgrad/kokoro) TTS, and publish them.

It lives in a **separate public repo on purpose**: GitHub Actions minutes are
unlimited for public repos but capped for private ones, and audio synthesis
(torch + Kokoro) is the minute-hungry part. The private repo keeps everything
sensitive (the LLM/text pipeline, auth, ranking, the website).

This repo contains **no secrets** and none of the private application code —
only the audio-generation closure and a 2-table view of the database.

---

## How the handoff works (no files are passed between repos)

Everything flows through the **shared Neon Postgres database** and the **shared
Cloudflare R2 bucket** — the two repos never exchange files directly.

```
   PRIVATE repo (Radio_News)              SHARED                 PUBLIC repo (this)
   ─────────────────────────              ──────                 ──────────────────
   text stage:                       ┌───────────────┐
   RSS → extract → LLM script  ─────▶│  Neon: segments│
   inserts a row with               │  status =      │
   status = 'pending_audio'         │  'pending_audio'│
   (script_text, voice_id, …)       └───────┬────────┘
                                             │ read pending rows
                                             ▼
                                     ┌──────────────────┐  Kokoro TTS (this repo)
                                     │  synthesize MP3   │◀── worker/tts_kokoro.py
                                     └───────┬──────────┘
                       upload audio/<id>.mp3 │
                                             ▼
                                     ┌───────────────┐
                                     │  R2 (public)  │
                                     └───────────────┘
                                             │ write back
                                             ▼
                                     ┌───────────────────────────┐
                                     │ Neon: segments            │
                                     │ status='ready', audio_url, │
                                     │ transcript, duration       │
                                     └───────┬───────────────────┘
                                             │ read
                                             ▼
                              Vercel website plays the public R2 URL
```

1. **Private text stage** writes a `segments` row: `status='pending_audio'`,
   plus `script_text`, `voice_id`, `category_id`, `headline`.
2. **This repo** (`npm run ingest:audio`, on a schedule) reads those rows,
   synthesizes the MP3 with Kokoro, uploads it to R2 at `audio/<id>.mp3`, and
   updates the same row: `audio_url`, `transcript` (per-sentence timing),
   `duration_seconds`, `status='ready'`.
3. **The website** (private repo, on Vercel) reads `ready` segments from the
   same DB and points the `<audio>` player at the public R2 URL.

The "output of the private repo" is therefore **database rows**, not text files,
and the audio reaches the website by being **uploaded to the shared R2 bucket**
whose public URL is stored on the row. No repo-to-repo transfer is involved.

---

## Security model — what is and isn't public

**Already public today (by design of the public PWA — unchanged by this repo):**
- The audio MP3s. The R2 bucket is public-read with unsigned URLs, so anyone
  with a URL can fetch/download a clip. (Required so browsers can stream them.)
- The script text, read-along transcript, and source links — the live website's
  `/api/feed` returns these to anonymous visitors.

**This repo additionally makes public:** its own source code (the Kokoro
pipeline + the 2-table schema *shape* below). That's it.

**NOT public:**
- **Secrets.** The DB connection string and R2 keys are stored as encrypted
  **GitHub Actions Secrets**. They are never shown in the repo, code, or Actions
  UI, and GitHub masks them in logs as `***`. The public cannot read them, and
  **cannot connect to the database** — connecting requires the secret string,
  which they don't have.
- The private application code (LLM prompts, auth, ranking, website).

**Why the credentials are scoped (least privilege):** see Setup. The DB role can
only `SELECT/UPDATE segments` and `SELECT categories`; the R2 token can only
read/write the audio bucket. So even in the unlikely event a secret leaks (e.g.
a workflow-exfiltration attack), the blast radius is the already-public news
clips — never user accounts, OAuth identities, or other data/buckets.

**Public-repo hardening built in:** the workflow triggers on `schedule` +
`workflow_dispatch` only (never `pull_request`), so a stranger's fork PR can
never run it with the secrets. Also enable, in repo Settings:
- Actions → "Require approval for all outside collaborators".
- Branch protection on `main` so the workflow YAML can't change without review.

---

## Setup

### 1. Create scoped credentials (do NOT reuse admin keys)

**Neon role** — run in the Neon SQL Editor (owner access), once:

```sql
CREATE ROLE audio_worker WITH LOGIN PASSWORD '<strong-random-password>';
GRANT USAGE ON SCHEMA public TO audio_worker;
GRANT SELECT, UPDATE ON segments TO audio_worker;
GRANT SELECT ON categories TO audio_worker;
```

Connection string (same host as your pooled URL, scoped role):
`postgresql://audio_worker:<password>@<your-neon-pooler-host>/neondb?sslmode=require`

**Cloudflare R2 token** — create an R2 API token **scoped to the audio bucket**
with **Object Read & Write** only. Note the new Access Key ID + Secret.

### 2. Add repo Secrets / Variables

Settings → Secrets and variables → Actions:

| Secrets | Variables |
| --- | --- |
| `DATABASE_URL` (scoped role) | `R2_BUCKET` (e.g. `news-radio-audio`) |
| `R2_ACCOUNT_ID` | `MAX_AUDIO_PER_RUN` (e.g. `20`) |
| `R2_ACCESS_KEY_ID` | `TTS_SENTENCE_GAP_SEC` (e.g. `0.28`) |
| `R2_SECRET_ACCESS_KEY` | |
| `R2_PUBLIC_BASE_URL` | |

### 3. Run

- Automatically: the workflow runs every 3 hours (30 min after the private
  text stage), picking up whatever `pending_audio` segments exist.
- Manually: Actions → "Ingest — audio" → Run workflow.
- Locally: copy `.env.example` → `.env`, `npm install`,
  `pip install -r worker/requirements-audio.txt` (+ `espeak-ng`), then
  `npm run ingest:audio`.

---

## Maintenance (keeping in sync with the private repo)

A few files are copied (trimmed) from the private repo and must be re-copied if
they change there:
- `lib/db/schema.ts` — if the `segments`/`categories` columns the audio stage
  uses change.
- `worker/tts_kokoro.py` — when the TTS pipeline is tuned (this is the file most
  likely to evolve).
- `lib/r2.ts`, `lib/config.ts`, `lib/providers/tts/*`, `worker/pipeline/audio.ts`
  — rarely.

`npm run typecheck` validates the TypeScript closure compiles.
