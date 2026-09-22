# NanoPulse

A dead man's switch for cron jobs, background workers and servers — the first service under
`nano-api.com`, served from `pulse.nano-api.com`.

Your job POSTs a ping on every successful run. If a ping does not arrive within the expected
interval plus a grace period, NanoPulse marks the monitor as **down** and (optionally) posts an
alert to a webhook.

Built on Cloudflare Workers + D1 + Hono, with a Cron Trigger doing the overdue sweep.

## API

Base URL in production: `https://pulse.nano-api.com`. Locally: `http://localhost:8787`.

Every `/v1/*` route is also served under `/pulse/v1/*`, so the same Worker can later sit behind a
shared `api.nano-api.com` gateway without breaking clients.

All `/v1/*` endpoints require `Authorization: Bearer <api_key>`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness + database check (no auth) |
| `POST`/`GET` | `/v1/ping/:slug` | Record a heartbeat. Creates the monitor on first ping |
| `GET` | `/v1/whoami` | Who the API key belongs to |
| `GET` | `/v1/monitors` | List monitors |
| `POST` | `/v1/monitors` | Create a monitor explicitly |
| `GET` | `/v1/monitors/:slug` | Monitor detail + last 20 pings and events |
| `PATCH` | `/v1/monitors/:slug` | Update `name`, `expected_interval_seconds`, `grace_period_seconds`, `alert_webhook_url`, `paused` |
| `DELETE` | `/v1/monitors/:slug` | Delete a monitor and its history |
| `POST` | `/v1/checks/run` | Run the overdue sweep for your own monitors (the cron does this every 5 minutes) |

### Ping

```bash
curl -X POST "http://localhost:8787/v1/ping/nightly-backup?interval=86400&grace=3600" \
  -H "Authorization: Bearer $NANOPULSE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"rows_exported": 12043}'
```

- `slug`: 1–63 chars, lowercase letters, digits, `-` or `_`.
- `interval` / `grace` (query params): only used when the monitor is auto-created on the first ping.
  Defaults are 3600 s interval and 300 s grace. Change them later with `PATCH`.
- `status=fail`: report a failed run. The monitor goes `down` immediately instead of waiting for a
  missed window.
- Request body: optional, kept as-is (max 2 KB) and shown in the ping log.

A monitor is `pending` until its first ping, then `ok`, `down` when it misses its window or reports
a failure, and `paused` when you disable it. A ping on a `down` monitor emits a recovery (`up`)
event.

### Alerts

Set `alert_webhook_url` (https only) on a monitor and NanoPulse POSTs a Slack-compatible JSON body
(`{"text": "🔴 Monitor 'x' has not pinged for …", …}`) on every `down` and `up` transition:

```bash
curl -X PATCH http://localhost:8787/v1/monitors/nightly-backup \
  -H "Authorization: Bearer $NANOPULSE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"alert_webhook_url": "https://hooks.slack.com/services/..."}'
```

Every transition is stored in `monitor_events` with a `notified` flag, so undelivered alerts are
visible in `GET /v1/monitors/:slug`.

## Local development

```bash
npm install
npm run dev          # applies migrations + seed, then starts wrangler dev on :8787
./scripts/smoke.sh   # end-to-end check against the running server
```

The seed (`seeds/test-data.sql`) installs a test user and this **local-only** API key:

```
np_test_7bc5c02094886b8a8bd2f1eda2774b1b1e3acde3
```

Useful extras:

```bash
npx wrangler dev --test-scheduled      # then: curl http://localhost:8787/__scheduled
npm run check                          # tsc + wrangler deploy --dry-run
node scripts/create-api-key.mjs you@example.com "Laptop key"   # mint a real key + SQL
```

## Data model

`migrations/0001_init_pulse_schema.sql` creates:

- `users` — id, email.
- `api_keys` — SHA-256 hash of the key (never the key itself), plus a display prefix and
  `last_used_at` / `revoked_at`.
- `monitors` — one per watched job: slug, interval, grace, status, `last_ping_at`, webhook.
- `ping_logs` — every received ping with IP, user agent and optional payload.
- `monitor_events` — `down` / `up` transitions and whether the alert was delivered.

All timestamps are unix epoch seconds (UTC) in the database and ISO-8601 in the API.

## Deploy

Prerequisites: the `nano-api.com` zone must be active on the same Cloudflare account as the Worker,
and the D1 database in `wrangler.json` (`nano-pulse-db`) must exist on that account.

```bash
npx wrangler login
npx wrangler d1 info nano-pulse-db     # confirm the database id matches wrangler.json
npm run db:migrate:remote              # also runs automatically via predeploy
npm run deploy                         # creates the pulse.nano-api.com custom domain + DNS record
```

`wrangler.json` binds the Worker to `pulse.nano-api.com` as a custom domain, so the first deploy
provisions the DNS record and certificate. Certificate issuance can take a few minutes.

Verify:

```bash
curl https://pulse.nano-api.com/health
curl -X POST https://pulse.nano-api.com/v1/ping/nightly-backup \
  -H "Authorization: Bearer $NANOPULSE_API_KEY"
```

To create a production API key, run `node scripts/create-api-key.mjs <email> "<name>"` and execute
the printed SQL with `npx wrangler d1 execute DB --remote --command "..."`. Do **not** run
`db:seed:remote` against production — that installs the shared test key.

The cron trigger (`*/5 * * * *` in `wrangler.json`) runs the overdue sweep; it only activates on a
deployed Worker, not in local dev.
