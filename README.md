# nano-api

Several small services in one Worker, sharing one database, one API key and one quota.

- **NanoPulse** (`pulse.nano-api.com`) tells you when a job you depend on has stopped running. Your
  job pings on every success; if the ping does not arrive within the expected interval plus a grace
  period, the monitor goes **down** and an alert goes out.
- **NanoRelay** (`relay.nano-api.com`) is the other half: we call *your* endpoint on a cron
  schedule, with timezone-correct timing, retries, timeouts and alerting on failure.
- **NanoLock** keeps two of them from running at once: `flock` over HTTP, with a TTL lease, a
  token only the holder knows, and a fencing counter.
- **NanoConfig** (`configmaps.nano-api.com`) holds the small JSON documents you would otherwise
  redeploy for: kill switches, feature flags, limits.

Built on Cloudflare Workers + D1 + Hono. One Cron Trigger drives the background work: the Pulse
overdue sweep, the Relay run sweep and the lock purge. They share `users`, `api_keys`, the quota and the alert delivery code, which
is the whole reason they live in one Worker.

## API

Base URL in production: `https://pulse.nano-api.com` or `https://relay.nano-api.com` — both
hostnames serve the same API. Locally: `http://localhost:8787`.

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
| `POST` | `/v1/checks/run` | Run the overdue sweep for your own monitors (the cron does this every minute) |
| `GET` | `/v1/keys` | List your API keys (prefixes only — full keys are unrecoverable) |
| `POST` | `/v1/keys` | Issue an additional key, for rotation |
| `DELETE` | `/v1/keys/:id` | Revoke a key |
| `POST` | `/v1/admin/users` | Provision a customer. Requires the `ADMIN_TOKEN` secret, not an API key |
| `PATCH` | `/v1/admin/users/:email` | Change a customer's `monitor_limit`. Requires `ADMIN_TOKEN` |
| `GET` | `/v1/schedules` | List schedules (Relay) |
| `POST` | `/v1/schedules` | Create a schedule |
| `GET` | `/v1/schedules/:slug` | Schedule detail + last 20 runs |
| `PATCH` | `/v1/schedules/:slug` | Update any field, including `paused` |
| `DELETE` | `/v1/schedules/:slug` | Delete a schedule and its run history |
| `POST` | `/v1/schedules/:slug/run` | Run now, without moving the schedule's own clock |
| `GET` | `/v1/locks` | List your locks and whether they are held |
| `POST` | `/v1/locks/:name` | Acquire. 201 with a token, or 409 if held |
| `GET` | `/v1/locks/:name` | Status, without revealing the holder's token |
| `POST` | `/v1/locks/:name/renew` | Extend the lease. Requires the token |
| `DELETE` | `/v1/locks/:name` | Release. Requires the token |
| `GET` | `/v1/configs` | List config documents |
| `GET` | `/v1/configs/:name` | Read a document. Sends an `ETag`; honours `If-None-Match` |
| `GET` | `/v1/configs/:name/keys/:key` | Read one value |
| `PUT` | `/v1/configs/:name` | Replace the document, creating it if absent |
| `PATCH` | `/v1/configs/:name` | Merge keys; `null` removes one |
| `GET` | `/v1/configs/:name/revisions` | The last 20 versions |
| `POST` | `/v1/configs/:name/rollback` | Restore an old version as a new one |
| `DELETE` | `/v1/configs/:name` | Delete the document and its history |

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

## NanoRelay

```bash
curl -X POST https://relay.nano-api.com/v1/schedules \
  -H "Authorization: Bearer $NANOPULSE_API_KEY" -H 'content-type: application/json' \
  -d '{
    "slug": "nightly-report",
    "cron": "0 3 * * *",
    "timezone": "Europe/Oslo",
    "url": "https://api.example.com/jobs/nightly-report",
    "body": {"source": "relay"},
    "max_attempts": 3,
    "timeout_seconds": 30,
    "alert_webhook_url": "https://hooks.slack.com/services/..."
  }'
```

- **Timezone-correct cron.** Five-field expressions evaluated in any IANA zone, so `0 3 * * *` in
  `Europe/Oslo` stays at 03:00 local across DST instead of drifting an hour twice a year.
  A nonexistent local time (spring forward) runs at the equivalent instant after the gap rather
  than being skipped; an ambiguous one (fall back) runs on its first instant. `test/cron.test.ts`
  pins all of this.
- **Retries.** Up to `max_attempts` (max 3) per run with 2s and 6s backoff, each attempt bounded by
  `timeout_seconds` (max 60).
- **Alerts on transition only**, the same rule as Pulse: one alert when it starts failing, one when
  it recovers. Not one per failed run.
- **Run history** in `GET /v1/schedules/:slug`: outcome, status code, duration, attempts, whether
  it was the cron or a manual run, and the first 512 characters of the response.
- **Missed slots are skipped, not replayed.** After an outage the next run is computed from *now*,
  so a backlog never stampedes the customer's endpoint.
- Outbound requests carry `X-NanoRelay-Run-Id` and `X-NanoRelay-Schedule`. Delivery is
  at-least-once, so endpoints must be idempotent.

### The target URL is attacker-controlled

A customer chooses the URL we call, which makes Relay an SSRF and abuse vector. Two layers, in
`src/relay/url-guard.ts`:

1. **Shape** — https only, no credentials, no `localhost`/`.internal`/`.local` host, and any IP
   literal must be public.
2. **Resolution** — the hostname is resolved over DoH and every answer must be a public address.
   This runs before *every* execution, not just at creation, because DNS can be repointed at
   `10.x` afterwards. Verified against `localtest.me`, a public name pointing at 127.0.0.1.

Redirects are not followed (`redirect: "manual"`), since a redirect could land somewhere private.

`RELAY_ALLOW_PRIVATE_TARGETS=true` disables both layers so you can point a schedule at a local
server. It belongs in `.dev.vars` and must never be set in production.

## NanoLock

```bash
# Acquire, or find out who has it
curl -X POST "$B/v1/locks/nightly-import?ttl=60&owner=$HOSTNAME" -H "Authorization: Bearer $KEY"
# -> 201 {"acquired":true,"token":"3d8a…","fence":4,"expires_at":"…"}
# -> 409 {"error":{"code":"lock_held","held_until":"…","owner":"pod-a"}}

curl -X POST "$B/v1/locks/nightly-import/renew?token=$TOKEN&ttl=60" -H "Authorization: Bearer $KEY"
curl -X DELETE "$B/v1/locks/nightly-import?token=$TOKEN" -H "Authorization: Bearer $KEY"
```

Non-blocking on purpose: you get the lock or you get 409, and the caller decides whether to retry.
There is no queue and no held-open connection.

### The guarantee, and its limits

Acquire is **one atomic statement** — an upsert that only overwrites a row whose lease has already
expired, with `RETURNING` to say whether it applied. Two simultaneous callers cannot both win; the
loser gets an empty result and a 409. Verified with 20 parallel requests against a fresh lock:
exactly one 201, nineteen 409s.

Release and renew are **token-scoped**. The token is returned only to the acquirer, so a process
that stalled past its TTL cannot release a lock somebody else now holds, and `GET` never reveals
it.

`fence` is a **monotonically increasing counter per lock name**, handed to each holder. It exists
because a TTL lease alone is not safe: if your process pauses past the TTL (GC, a suspended VM),
another caller legitimately acquires, and now two processes believe they hold the lock. The fix is
for the resource you are protecting to remember the highest fence it has seen and reject anything
older. That is why releasing **expires** the row instead of deleting it — a deleted row would
restart the counter at 1, and a fencing check would then reject the legitimate new holder. Rows
are swept only after 30 days unused, so a name left alone that long starts over.

Be honest with yourself about what this is: a lease, not consensus. Renew while you work, keep the
TTL above your worst-case runtime, and use the fence where correctness actually matters.

Locks do **not** count against the monitor/schedule quota — that quota is for things we watch or
run for you. There is a ceiling of 100 distinct lock names per user, purely to bound abuse.

## NanoConfig

```bash
curl -X PUT "$B/v1/configs/checkout" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"maintenance": false, "max_items": 50, "rollout": {"eu": 0.25}}'

# The kill switch, from anywhere
curl -X PATCH "$B/v1/configs/checkout?note=incident-4711" -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'if-match: "1"' \
  -d '{"maintenance": true}'

curl -s "$B/v1/configs/checkout/keys/maintenance" -H "Authorization: Bearer $KEY"
# {"name":"checkout","key":"maintenance","value":true,"version":2}
```

Three decisions worth knowing:

- **Polling is cheap.** Reads carry an `ETag` of the version; send `If-None-Match` and an unchanged
  document answers `304` with no body. A process can check every few seconds without cost.
- **Concurrent writes do not clobber.** `If-Match: "7"` writes only if the document is still at
  version 7, and the check and the write are one statement. The loser gets `412` with both version
  numbers, rather than silently winning.
- **Rollback moves forward.** Restoring version 1 writes its content as a *new* version, never
  rewinding the counter — for the same reason the lock's fence never goes backwards: a client
  caching by version must never see one number mean two things.

`PATCH` merges at the top level and a `null` value removes a key. The last 20 versions are kept
with an optional `?note=`, which is what you read afterwards to see who flipped the switch during
the incident.

Limits: 32 KB per document, 200 keys, key names `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Documents count
against the shared quota.

## Provisioning customers

Customers are provisioned from the terminal with the admin endpoint, which is guarded by the
`ADMIN_TOKEN` secret instead of an API key:

```bash
npx wrangler secret put ADMIN_TOKEN      # once per environment

curl -X POST https://pulse.nano-api.com/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"customer@example.com","name":"Onboarding key"}'
```

The response contains the plaintext key — it is stored only as a SHA-256 hash, so this response is
the one chance to capture it. Calling the endpoint again with the same email reuses the user and
just adds another key (`user_created: false`). If `ADMIN_TOKEN` is not set, the admin routes answer
503 rather than running unprotected.

### Quotas

Each user has a `monitor_limit` (default 5), and it covers **monitors, schedules and configs
together** — a plan is one integer, not a catalogue, so upgrading a customer is one call:

```bash
curl -X PATCH https://pulse.nano-api.com/v1/admin/users/customer@example.com \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"monitor_limit":100}'
```

It can also be set when provisioning (`{"email":"...","monitor_limit":100}`), and customers see
their own usage in `GET /v1/whoami`:

```json
{ "usage": { "monitors": 1, "schedules": 3, "configs": 1, "used": 5, "limit": 5, "remaining": 0 } }
```

The limit guards *creation* only — `POST /v1/monitors`, the auto-create on first ping,
`POST /v1/schedules` and the first `PUT` of a config — which answer:

```json
{ "error": { "code": "quota_exceeded", "message": "...", "used": 5, "limit": 5 } }
```

Pings to existing monitors and runs of existing schedules are never rejected for quota reasons, so
lowering a limit can never silently stop a customer's monitoring. Deleting either frees a slot
immediately. For an effectively unlimited customer, set a large number.

### Key rotation (self-service)

The API key is the customer's whole identity — there is no login, so key management is authenticated
by an existing key:

```bash
curl -X POST $B/v1/keys -H "Authorization: Bearer $OLD_KEY" -d '{"name":"Rotated key"}'
curl -X DELETE $B/v1/keys/<old_key_id> -H "Authorization: Bearer $NEW_KEY"
```

Revoking the key used for the request is refused (409) so nobody can lock themselves out; rotate
first, then revoke the old key with the new one.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # local ADMIN_TOKEN + Relay dev flag, gitignored
npm run dev                      # applies migrations + seed, then starts wrangler dev on :8787
npm test                         # cron/DST and URL-guard unit tests
./scripts/smoke.sh               # end-to-end check against the running server
```

`ADMIN_TOKEN=local-admin-token ./scripts/smoke.sh` also exercises the provisioning endpoint.

The seed (`seeds/test-data.sql`) installs a test user and this **local-only** API key:

```
np_test_7bc5c02094886b8a8bd2f1eda2774b1b1e3acde3
```

Useful extras:

```bash
npx wrangler dev --test-scheduled      # then: curl http://localhost:8787/__scheduled
npm run check                          # tsc + wrangler deploy --dry-run
```

## Code layout

```
src/core/    identity and plumbing every service shares: API-key auth, key minting,
             user provisioning, the quota, alert delivery, ids, time, validation
src/pulse/   heartbeat monitoring: monitors, the overdue sweep, ping and monitor routes
src/relay/   scheduled calls: cron parsing, the run engine, target URL guard, routes
src/lock/    mutual exclusion: lease acquire/renew/release, fencing, routes
src/config/  small JSON documents: validation, merge, versioning, revisions, routes
```

The boundary is deliberate. `core` knows nothing about monitors or schedules, which is what keeps
a future split into two Workers a matter of moving directories rather than untangling imports. See
`ROADMAP.md` in the site repo for the triggers that would justify that split; none of them are
true yet.

## Data model

`migrations/0001_init_pulse_schema.sql` creates:

- `users` — id, email, `monitor_limit`.
- `api_keys` — SHA-256 hash of the key (never the key itself), plus a display prefix and
  `last_used_at` / `revoked_at`. A user can hold several keys, which is how rotation works.
- `monitors` — one per watched job: slug, interval, grace, status, `last_ping_at`, webhook.
- `ping_logs` — every received ping with IP, user agent and optional payload.
- `monitor_events` — `down` / `up` transitions and whether the alert was delivered.
- `schedules` — Relay: cron, timezone, target request, retry policy, `next_run_at`, `last_status`.
- `schedule_runs` — every execution with outcome, status code, duration, attempts and response
  excerpt.
- `locks` — one row per (user, lock name): current token, owner, lease expiry and the fence
  counter, which outlives any individual acquisition.
- `configs` / `config_revisions` — the current document and its last 20 versions.

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

Set the admin secret once with `npx wrangler secret put ADMIN_TOKEN`, then create API keys with
`POST /v1/admin/users` as described above. Do **not** run `db:seed:remote` against production —
that installs the shared test key.

The cron trigger (`*/5 * * * *` in `wrangler.json`) runs the overdue sweep; it only activates on a
deployed Worker, not in local dev.
