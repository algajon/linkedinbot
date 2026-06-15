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

## Deployment

Free-tier setup: a Render **free** web service + external Postgres (Neon/Supabase
free tier via `DATABASE_URL`) + a free external cron (e.g. cron-job.org) that
POSTs hourly to `/internal/publish-due-posts` with the `x-internal-cron-secret`
header. Because free web services sleep when idle, `PUBLISH_SCHEDULER=off` and
the external cron both wakes the service and publishes due posts. Set the
`sync: false` secrets in the Render dashboard; the build runs `prisma migrate deploy`.

For an always-on paid setup instead, set `plan: starter` and `PUBLISH_SCHEDULER=on`
to run the publisher in-process hourly (no external cron needed).
