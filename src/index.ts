import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAdminToken, requireApiKey } from "./lib/auth";
import { runDueChecks } from "./lib/checks";
import { monitorUsage } from "./lib/limits";
import admin from "./routes/admin";
import keys from "./routes/keys";
import monitors from "./routes/monitors";
import ping from "./routes/ping";
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
		case 503:
			return "unavailable";
		default:
			return "error";
	}
}

app.get("/", (c) =>
	c.json({
		service: "nanopulse",
		description: "Dead man's switch for cron jobs, background workers and servers.",
		version: "v1",
		endpoints: {
			ping: "POST /v1/ping/:slug",
			list_monitors: "GET /v1/monitors",
			create_monitor: "POST /v1/monitors",
			monitor_detail: "GET /v1/monitors/:slug",
			update_monitor: "PATCH /v1/monitors/:slug",
			delete_monitor: "DELETE /v1/monitors/:slug",
			run_checks: "POST /v1/checks/run",
			list_keys: "GET /v1/keys",
			create_key: "POST /v1/keys",
			revoke_key: "DELETE /v1/keys/:id",
		},
		path_alias: "Every /v1/* route is also served under /pulse/v1/*.",
		auth: "Authorization: Bearer <api_key>",
	}),
);

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

const v1 = new Hono<AppEnv>();
v1.use("*", requireApiKey);
v1.route("/ping", ping);
v1.route("/monitors", monitors);
v1.route("/keys", keys);

// Manual sweep, scoped to the caller. Useful while testing without waiting for cron.
v1.post("/checks/run", async (c) => c.json(await runDueChecks(c.env, { userId: c.get("user").id })));

v1.get("/whoami", async (c) => {
	const user = c.get("user");
	const apiKey = c.get("apiKey");
	return c.json({
		user: { email: user.email },
		api_key: { name: apiKey.name, prefix: apiKey.key_prefix },
		monitors: await monitorUsage(c.env, user),
	});
});

// Canonical on the dedicated subdomain (pulse.nano-api.com/v1/...), with the
// /pulse/v1 prefix kept so a shared api.nano-api.com gateway can front it later.
app.route("/v1", v1);
app.route("/pulse/v1", v1);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			runDueChecks(env)
				.then((summary) => {
					if (summary.monitors_marked_down > 0) {
						console.log(`marked down: ${summary.slugs.join(", ")}`);
					}
				})
				.catch((error) => console.error("scheduled check failed", error)),
		);
	},
} satisfies ExportedHandler<Env>;
