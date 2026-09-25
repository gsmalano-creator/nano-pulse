import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAdminToken, requireApiKey } from "./core/auth";
import { contentSecurityPolicy, dashboardHtml } from "./dash/page";
import { runDueChecks } from "./pulse/checks";
import { purgeExpiredLocks } from "./lock/locks";
import { runDueSchedules } from "./relay/runner";
import { quotaUsage } from "./core/limits";
import admin from "./core/routes/admin";
import keys from "./core/routes/keys";
import signup from "./core/routes/signup";
import monitors from "./pulse/routes/monitors";
import badgeRoutes from "./count/routes/badge";
import configsRoutes from "./config/routes/configs";
import countersRoutes from "./count/routes/counters";
import uniqRoutes from "./uniq/routes/uniq";
import { purgeUniqKeys } from "./uniq/keys";
import locksRoutes from "./lock/routes/locks";
import schedules from "./relay/routes/schedules";
import ping from "./pulse/routes/ping";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		// Routes that need a machine-readable code build their own response.
		if (error.res) return error.res;
		return c.json(
			{ error: { code: statusCode(error.status), message: error.message } },
			error.status,
		);
	}
	console.error("unhandled error", error);
	return c.json({ error: { code: "internal_error", message: "Unexpected error." } }, 500);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404));

function statusCode(status: number): string {
	switch (status) {
		case 400:
			return "bad_request";
		case 401:
			return "unauthorized";
		case 404:
			return "not_found";
		case 403:
			return "forbidden";
		case 409:
			return "conflict";
		case 429:
			return "rate_limited";
		case 503:
			return "unavailable";
		default:
			return "error";
	}
}

/**
 * The read-only dashboard. Served from this worker on purpose: the worker
 * answers the whole API on every hostname it is routed to, so the page can
 * fetch /v1/monitors on its own origin. Hosting it anywhere else would mean
 * opening CORS on authenticated endpoints, which is a larger hole than a
 * dashboard is worth.
 */
function serveDashboard(c: Context<AppEnv>) {
	const nonce = crypto.randomUUID().replace(/-/g, "");
	const url = new URL(c.req.url);
	// Documented curl examples should point at a host the reader can use.
	const pulseBase = url.hostname.endsWith("nano-api.com")
		? "https://pulse.nano-api.com"
		: url.origin;

	c.header("content-type", "text/html; charset=utf-8");
	c.header("content-security-policy", contentSecurityPolicy(nonce));
	c.header("referrer-policy", "no-referrer");
	c.header("x-content-type-options", "nosniff");
	// A key gets pasted into this page; it has no business in someone's frame.
	c.header("x-frame-options", "DENY");
	c.header("cache-control", "no-store");
	return c.html(dashboardHtml(nonce, pulseBase));
}

const apiIndex = (c: Context<AppEnv>) =>
	c.json({
		service: "nano-api",
		description:
			"Small APIs that each do one thing: notice when a job stops running, run it on schedule, keep two copies from running at once, and hold the config you would otherwise redeploy for.",
		version: "v1",
		endpoints: {
			ping: "POST /v1/ping/:slug",
			list_monitors: "GET /v1/monitors",
			create_monitor: "POST /v1/monitors",
			monitor_detail: "GET /v1/monitors/:slug",
			update_monitor: "PATCH /v1/monitors/:slug",
			delete_monitor: "DELETE /v1/monitors/:slug",
			run_checks: "POST /v1/checks/run",
			sign_up: "POST /v1/signup (no key needed — this is how you get one)",
			list_keys: "GET /v1/keys",
			create_key: "POST /v1/keys  (body: {\"scope\": \"read\" | \"write\"})",
			revoke_key: "DELETE /v1/keys/:id",
			list_schedules: "GET /v1/schedules",
			create_schedule: "POST /v1/schedules",
			schedule_detail: "GET /v1/schedules/:slug",
			update_schedule: "PATCH /v1/schedules/:slug",
			delete_schedule: "DELETE /v1/schedules/:slug",
			run_schedule_now: "POST /v1/schedules/:slug/run",
			list_locks: "GET /v1/locks",
			acquire_lock: "POST /v1/locks/:name",
			lock_status: "GET /v1/locks/:name",
			renew_lock: "POST /v1/locks/:name/renew",
			release_lock: "DELETE /v1/locks/:name",
			list_configs: "GET /v1/configs",
			read_config: "GET /v1/configs/:name",
			read_config_key: "GET /v1/configs/:name/keys/:key",
			write_config: "PUT /v1/configs/:name",
			patch_config: "PATCH /v1/configs/:name",
			config_revisions: "GET /v1/configs/:name/revisions",
			rollback_config: "POST /v1/configs/:name/rollback",
			delete_config: "DELETE /v1/configs/:name",
			seen_before: "POST /v1/uniq/:key?ttl=86400  (201 first time, 200 after)",
			peek_key: "GET /v1/uniq/:key",
			forget_key: "DELETE /v1/uniq/:key",
			list_counters: "GET /v1/counters",
			increment_counter: "POST /v1/counters/:name?by=1",
			set_counter: "PUT /v1/counters/:name",
			delete_counter: "DELETE /v1/counters/:name",
			public_badge: "GET /b/:public_id.svg (no key needed)",
		},
		path_alias: "Every /v1/* route is also served under /pulse/v1/*.",
		auth: "Authorization: Bearer <api_key>",
	});

// Reachable at /dash on any host, which is what makes it testable locally.
app.get("/dash", serveDashboard);

app.get("/", (c) => {
	if (new URL(c.req.url).hostname.startsWith("dash.")) return serveDashboard(c);
	return apiIndex(c);
});

app.get("/health", async (c) => {
	try {
		await c.env.DB.prepare("SELECT 1").first();
		return c.json({ status: "ok" });
	} catch (error) {
		console.error("health check failed", error);
		return c.json({ status: "degraded", detail: "database unavailable" }, 503);
	}
});

// Operator-only routes, guarded by the ADMIN_TOKEN secret rather than an API key.
// Mounted before the API-key middleware so the two auth schemes stay separate.
const adminApi = new Hono<AppEnv>();
adminApi.use("*", requireAdminToken);
adminApi.route("/", admin);
app.route("/v1/admin", adminApi);

// Signup is mounted before the API-key middleware: it is the one route that
// cannot require a key, since issuing one is the point.
// Badges are embedded in READMEs and fetched anonymously, so they sit outside
// the API-key middleware with their own unguessable id.
app.route("/b", badgeRoutes);

app.route("/v1/signup", signup);
app.route("/pulse/v1/signup", signup);

const v1 = new Hono<AppEnv>();
v1.use("*", requireApiKey);
v1.route("/ping", ping);
v1.route("/monitors", monitors);
v1.route("/keys", keys);
v1.route("/schedules", schedules);
v1.route("/locks", locksRoutes);
v1.route("/configs", configsRoutes);
v1.route("/counters", countersRoutes);
v1.route("/uniq", uniqRoutes);

// Manual sweep, scoped to the caller. Useful while testing without waiting for cron.
v1.post("/checks/run", async (c) => c.json(await runDueChecks(c.env, { userId: c.get("user").id })));

v1.get("/whoami", async (c) => {
	const user = c.get("user");
	const apiKey = c.get("apiKey");
	return c.json({
		user: { email: user.email },
		// scope is here so a client can tell what it is holding before it tries a
		// write and learns the hard way. The dashboard refuses anything but "read".
		api_key: { name: apiKey.name, prefix: apiKey.key_prefix, scope: apiKey.scope },
		usage: await quotaUsage(c.env, user),
	});
});

// Canonical on the dedicated subdomain (pulse.nano-api.com/v1/...), with the
// /pulse/v1 prefix kept so a shared api.nano-api.com gateway can front it later.
app.route("/v1", v1);
app.route("/pulse/v1", v1);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		// Pulse looks for silence; Relay does the work. One trigger drives both,
		// and neither is allowed to take the other down.
		ctx.waitUntil(
			runDueChecks(env)
				.then((summary) => {
					if (summary.monitors_marked_down > 0) {
						console.log(`marked down: ${summary.slugs.join(", ")}`);
					}
				})
				.catch((error) => console.error("scheduled check failed", error)),
		);
		// Locks expire on read; this only stops long-dead rows accumulating.
		ctx.waitUntil(
			purgeExpiredLocks(env).catch((error) => console.error("lock purge failed", error)),
		);
		// Expiry is honoured on read, so this only reclaims space -- and trims
		// an account that has blown past the live-key cap.
		ctx.waitUntil(
			purgeUniqKeys(env).catch((error) => console.error("uniq purge failed", error)),
		);
		ctx.waitUntil(
			runDueSchedules(env)
				.then((summary) => {
					if (summary.schedules_run > 0) {
						console.log(
							`ran ${summary.schedules_run} schedule(s), ${summary.failed} failed: ${summary.slugs.join(", ")}`,
						);
					}
				})
				.catch((error) => console.error("scheduled relay sweep failed", error)),
		);
	},
} satisfies ExportedHandler<Env>;
