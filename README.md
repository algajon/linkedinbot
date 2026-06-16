# LinkedIn Scheduled Poster

Schedule LinkedIn posts and publish them automatically when their time arrives.
The app handles scheduling itself — it does **not** rely on any native LinkedIn
scheduling feature. A worker runs every minute, finds due posts, and calls
LinkedIn's publishing API.

## Stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js + Express (ESM) |
| Database | PostgreSQL |
| ORM | Prisma |
| Frontend | Server-rendered EJS |
| Background | Cron job running `scripts/publishDuePosts.js` |
| Deploy | Render (`render.yaml`) |

## MVP features

- Email/password registration and login (sessions, bcrypt, Postgres session store).
- Connect a LinkedIn account via OAuth (OpenID Connect for the member URN).
- **AI post generation** — generate post drafts from a topic in a chosen tone of
  voice (OpenAI), then edit before scheduling.
- Create text-only posts scheduled for a date, time, and timezone.
- Edit, cancel, retry, and delete posts.
- Automatic publishing via an in-process hourly scheduler with row locking (no double posts).
- Status tracking: `DRAFT`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `FAILED`, `CANCELED`.

## Local setup

```bash
npm install
cp .env.example .env        # fill in the values
openssl rand -hex 32        # use for TOKEN_ENCRYPTION_KEY
npx prisma migrate dev      # create the schema in your local Postgres
npm run dev                 # http://localhost:3000
```

You need a running PostgreSQL instance and a LinkedIn developer app with the
`openid profile email w_member_social` scopes and a redirect URI matching
`LINKEDIN_REDIRECT_URI`.

### Running the publisher

The web service runs the publisher **in-process on an hourly timer** when
`PUBLISH_SCHEDULER=on` (the default in production). No separate cron job is
needed. Tune the cadence with `PUBLISH_INTERVAL_MINUTES`.

You can also trigger it manually or externally:

```bash
npm run publish:due                              # one pass from the CLI
# or hit the protected endpoint:
curl -X POST -H "x-internal-cron-secret: $CRON_SECRET" \
  "$APP_BASE_URL/internal/publish-due-posts"
```

## Environment variables

See [.env.example](.env.example). Required: `DATABASE_URL`, `SESSION_SECRET`,
`TOKEN_ENCRYPTION_KEY` (32 bytes), `CRON_SECRET`, and the `LINKEDIN_*` values.

## How publishing works (idempotency)

1. The worker selects `SCHEDULED` posts where `scheduledAt <= now()` (batch of 25).
2. For each, it does an atomic `updateMany` flipping `SCHEDULED → PUBLISHING`,
   and only proceeds if exactly one row changed — this is the lock that prevents
   duplicate publishing across concurrent workers.
3. It fetches and (if needed) refreshes the encrypted access token, calls the
   LinkedIn Posts API, and records `PUBLISHED` + the returned URN, or `FAILED` +
   the error message. Every attempt is written to `PublishLog`.
4. Posts stuck in `PUBLISHING` past a threshold (crashed worker) are reclaimed
   to `FAILED` so they can be inspected and retried manually.

Access tokens are encrypted at rest with AES-256-GCM and are never exposed to
the browser.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create account |
| POST | `/auth/login` | Log in |
| POST | `/auth/logout` | Log out |
| GET | `/auth/me` | Current user (JSON) |
| GET | `/auth/linkedin` | Start OAuth |
| GET | `/auth/linkedin/callback` | OAuth callback |
| POST | `/auth/linkedin/disconnect` | Disconnect LinkedIn |
| POST | `/api/ai/generate` | Generate post text from `{ topic, tone, audience }` |
| GET/POST | `/api/posts` | List / create posts |
| GET/PATCH/DELETE | `/api/posts/:id` | Read / update / delete |
| POST | `/api/posts/:id/cancel` | Cancel |
| POST | `/api/posts/:id/retry` | Retry failed |
| POST | `/internal/publish-due-posts` | Cron trigger (needs `x-internal-cron-secret`) |

## Commentary on current events (news)

Post an informed take on something happening now. A content source can be:
- a **PDF** (upload),
- a **URL** — pasted on the Sources page; the article is fetched and its text
  extracted live,
- a **news topic** — searched via GDELT (with a Google News RSS fallback); free,
  no API key. The top recent articles are fetched and assembled into context.

Generation is grounded strictly in that context (no fabricated facts) and writes
*your take* in the chosen voice with a **stance** (sharp take, supportive,
contrarian, what-it-means, myth-bust, prediction). **News watches** (Tier C)
monitor a topic and auto-draft a take on fresh articles into the approval queue
(checked hourly, throttled to a couple per day per watch). News search is
best-effort/keyless — for a guaranteed feed, slot in a keyed provider in
`webContext.service.js`.

## On-prem LLM (sovereign AI)

PDF-based draft generation can run against an internal **DGX Spark / vLLM**
cluster instead of OpenAI, so document content never leaves the network. Set
`DGX_BASE_URL`, `DGX_API_KEY`, `DGX_MODEL`, and optionally `DGX_LLM_TIER`
(`fast` | `heavy`). When configured, *source generation* prefers the DGX
cluster and falls back to OpenAI only if it isn't set. vLLM is OpenAI-compatible;
reasoning output is suppressed via `chat_template_kwargs.enable_thinking=false`,
and posts are returned as delimiter-separated text (robust to multi-line bodies).

The cluster is LAN/VPN-only, so this works when the app runs **on-prem or in the
office network** — not from a public cloud host (which transparently falls back
to OpenAI). Topic-based generation and tone-learning still use OpenAI.

## Per-author tone (few-shot + optional fine-tuning)

Saved **tone presets** capture a person's voice. By default generation is
**few-shot**: the preset's distilled brief plus several of the author's real
posts (stored in `sampleText`, `===POST===` delimited) are injected into the
prompt. Strong anti-"AI tell" rules + a post-processor (`deAiify`) strip em
dashes, markdown, bullet/numbered lists, emoji spam, and generic filler hashtags.

**Quality engine** (`CONTENT_QUALITY=on`, default): every post is vetted, not
one-shot. Topic posts generate several varied drafts, an LLM judge picks the
strongest (hook + authenticity weighted), then a self-refine pass lifts it
against a quality rubric (hook, one idea, specificity, value, readability,
authenticity, engagement). Source posts are grounded strictly in the document
and each is refined the same way. Set `CONTENT_QUALITY=off` for cheaper one-shot.

For maximum fidelity you can **fine-tune per author** (optional, scripts only —
nothing runs or spends automatically):

**Topic posts → OpenAI fine-tune** (`scripts/fineTune.js`):
```bash
node scripts/fineTune.js export "Olha Siuta" fine-tune/olha.jsonl   # build chat JSONL
node scripts/fineTune.js launch fine-tune/olha.jsonl "Olha Siuta"   # uploads + starts job ($)
node scripts/fineTune.js status <jobId> "Olha Siuta"                # writes openaiModel onto the preset
```
Once `TonePreset.openaiModel` is set, topic generation uses that fine-tuned model.

**Source posts → DGX LoRA** (`scripts/train_dgx_lora.py`, runs on the DGX GPU):
```bash
python scripts/train_dgx_lora.py --data fine-tune/olha.jsonl \
  --base-model Qwen/Qwen2.5-72B-Instruct --out adapters/olha
vllm serve Qwen/Qwen2.5-72B-Instruct --enable-lora --lora-modules olha=adapters/olha
# then: UPDATE "TonePreset" SET "dgxLora"='olha' WHERE name LIKE 'Olha%';
```
Once `TonePreset.dgxLora` is set, source generation routes to that LoRA adapter.

## Deployment

Free-tier setup: a Render **free** web service + external Postgres (Neon/Supabase
free tier via `DATABASE_URL`) + a free external cron (e.g. cron-job.org) that
POSTs hourly to `/internal/publish-due-posts` with the `x-internal-cron-secret`
header. Because free web services sleep when idle, `PUBLISH_SCHEDULER=off` and
the external cron both wakes the service and publishes due posts. Set the
`sync: false` secrets in the Render dashboard; the build runs `prisma migrate deploy`.

For an always-on paid setup instead, set `plan: starter` and `PUBLISH_SCHEDULER=on`
to run the publisher in-process hourly (no external cron needed).
