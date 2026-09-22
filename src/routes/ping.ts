import { Hono } from "hono";
import type { Context } from "hono";
import { recordEvent } from "../lib/alerts";
import { newId } from "../lib/ids";
import {
	DEFAULT_GRACE_SECONDS,
	DEFAULT_INTERVAL_SECONDS,
	parseGrace,
	parseInterval,
	parseSlug,
	serializeMonitor,
} from "../lib/monitors";
import { nowSeconds } from "../lib/time";
import type { AppEnv, MonitorRow } from "../types";

/** Pings may carry a small payload (e.g. job stats); anything bigger is dropped. */
const MAX_PAYLOAD_BYTES = 2048;

const ping = new Hono<AppEnv>();

async function readPayload(c: Context<AppEnv>): Promise<string | null> {
	const contentLength = Number(c.req.header("content-length") ?? "0");
	if (!Number.isFinite(contentLength) || contentLength === 0) return null;
	if (contentLength > MAX_PAYLOAD_BYTES) return null;
	const text = await c.req.text();
	const trimmed = text.trim();
	return trimmed === "" ? null : trimmed.slice(0, MAX_PAYLOAD_BYTES);
}

/**
 * The endpoint customers call from cron jobs and background workers.
 * GET is accepted as well so `curl` and `wget` one-liners work unchanged.
 */
ping.on(["POST", "GET"], "/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const user = c.get("user");
	const now = nowSeconds();

	const intervalOverride = c.req.query("interval");
	const graceOverride = c.req.query("grace");
	const reportedStatus = c.req.query("status") === "fail" ? "fail" : "ok";

	// Auto-provision on first ping so customers can start without a setup call.
	// ON CONFLICT makes two simultaneous first pings safe.
	await c.env.DB.prepare(
		`INSERT INTO monitors (id, user_id, slug, expected_interval_seconds, grace_period_seconds, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id, slug) DO NOTHING`,
	)
		.bind(
			newId("mon"),
			user.id,
			slug,
			intervalOverride === undefined ? DEFAULT_INTERVAL_SECONDS : parseInterval(intervalOverride),
			graceOverride === undefined ? DEFAULT_GRACE_SECONDS : parseGrace(graceOverride),
			now,
			now,
		)
		.run();

	const monitor = await c.env.DB.prepare("SELECT * FROM monitors WHERE user_id = ? AND slug = ?")
		.bind(user.id, slug)
		.first<MonitorRow>();

	if (!monitor) {
		// Should be unreachable: the insert above either created or found the row.
		return c.json({ error: { code: "monitor_unavailable", message: "Could not resolve monitor." } }, 500);
	}

	const payload = await readPayload(c);
	const nextStatus = reportedStatus === "fail" ? "down" : "ok";

	await c.env.DB.batch([
		c.env.DB.prepare(
			"UPDATE monitors SET last_ping_at = ?, status = ?, updated_at = ? WHERE id = ?",
		).bind(now, nextStatus, now, monitor.id),
		c.env.DB.prepare(
			`INSERT INTO ping_logs (monitor_id, received_at, reported_status, source_ip, user_agent, payload)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).bind(
			monitor.id,
			now,
			reportedStatus,
			c.req.header("cf-connecting-ip") ?? null,
			c.req.header("user-agent")?.slice(0, 256) ?? null,
			payload,
		),
	]);

	// Only transitions are alert-worthy, not every ping.
	if (nextStatus === "down" && monitor.status !== "down") {
		c.executionCtx.waitUntil(
			recordEvent(c.env, monitor, "down", `Monitor '${slug}' reported a failure.`),
		);
	} else if (nextStatus === "ok" && monitor.status === "down") {
		c.executionCtx.waitUntil(
			recordEvent(c.env, monitor, "up", `Monitor '${slug}' is reporting again.`),
		);
	}

	return c.json({
		ok: true,
		received_at: new Date(now * 1000).toISOString(),
		monitor: serializeMonitor({
			...monitor,
			last_ping_at: now,
			status: nextStatus,
			updated_at: now,
		}),
	});
});

export default ping;
