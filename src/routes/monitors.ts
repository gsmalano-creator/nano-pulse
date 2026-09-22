import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { newId } from "../lib/ids";
import {
	DEFAULT_GRACE_SECONDS,
	DEFAULT_INTERVAL_SECONDS,
	parseGrace,
	parseInterval,
	parseName,
	parseSlug,
	parseWebhookUrl,
	serializeMonitor,
} from "../lib/monitors";
import { nowSeconds, toIso } from "../lib/time";
import type { AppEnv, MonitorEventRow, MonitorRow, PingLogRow } from "../types";

const RECENT_LIMIT = 20;

const monitors = new Hono<AppEnv>();

async function findMonitor(
	db: D1Database,
	userId: string,
	slug: string,
): Promise<MonitorRow> {
	const monitor = await db
		.prepare("SELECT * FROM monitors WHERE user_id = ? AND slug = ?")
		.bind(userId, slug)
		.first<MonitorRow>();
	if (!monitor) {
		throw new HTTPException(404, { message: `No monitor with slug '${slug}'.` });
	}
	return monitor;
}

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new HTTPException(400, { message: "Request body must be JSON." });
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HTTPException(400, { message: "Request body must be a JSON object." });
	}
	return body as Record<string, unknown>;
}

monitors.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM monitors WHERE user_id = ? ORDER BY slug ASC",
	)
		.bind(c.get("user").id)
		.all<MonitorRow>();

	return c.json({ monitors: (results ?? []).map(serializeMonitor) });
});

monitors.post("/", async (c) => {
	const body = await readJsonBody(c);
	const slug = parseSlug(body.slug as string | undefined);
	const now = nowSeconds();

	const interval =
		body.expected_interval_seconds === undefined
			? DEFAULT_INTERVAL_SECONDS
			: parseInterval(body.expected_interval_seconds);
	const grace =
		body.grace_period_seconds === undefined
			? DEFAULT_GRACE_SECONDS
			: parseGrace(body.grace_period_seconds);

	const existing = await c.env.DB.prepare("SELECT id FROM monitors WHERE user_id = ? AND slug = ?")
		.bind(c.get("user").id, slug)
		.first<{ id: string }>();
	if (existing) {
		throw new HTTPException(409, {
			message: `Monitor '${slug}' already exists. Use PATCH to change it.`,
		});
	}

	await c.env.DB.prepare(
		`INSERT INTO monitors (id, user_id, slug, name, expected_interval_seconds, grace_period_seconds,
		                       alert_webhook_url, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			newId("mon"),
			c.get("user").id,
			slug,
			parseName(body.name),
			interval,
			grace,
			parseWebhookUrl(body.alert_webhook_url),
			now,
			now,
		)
		.run();

	const created = await findMonitor(c.env.DB, c.get("user").id, slug);
	return c.json({ monitor: serializeMonitor(created) }, 201);
});

monitors.get("/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const monitor = await findMonitor(c.env.DB, c.get("user").id, slug);

	const [pings, events] = await c.env.DB.batch<PingLogRow | MonitorEventRow>([
		c.env.DB.prepare(
			"SELECT * FROM ping_logs WHERE monitor_id = ? ORDER BY received_at DESC, id DESC LIMIT ?",
		).bind(monitor.id, RECENT_LIMIT),
		c.env.DB.prepare(
			"SELECT * FROM monitor_events WHERE monitor_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
		).bind(monitor.id, RECENT_LIMIT),
	]);

	return c.json({
		monitor: serializeMonitor(monitor),
		recent_pings: (pings.results as PingLogRow[]).map((row) => ({
			received_at: toIso(row.received_at),
			reported_status: row.reported_status,
			source_ip: row.source_ip,
			user_agent: row.user_agent,
			payload: row.payload,
		})),
		recent_events: (events.results as MonitorEventRow[]).map((row) => ({
			created_at: toIso(row.created_at),
			event_type: row.event_type,
			message: row.message,
			notified: row.notified === 1,
		})),
	});
});

monitors.patch("/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const monitor = await findMonitor(c.env.DB, c.get("user").id, slug);
	const body = await readJsonBody(c);

	const updates: string[] = [];
	const values: unknown[] = [];

	if (body.name !== undefined) {
		updates.push("name = ?");
		values.push(parseName(body.name));
	}
	if (body.expected_interval_seconds !== undefined) {
		updates.push("expected_interval_seconds = ?");
		values.push(parseInterval(body.expected_interval_seconds));
	}
	if (body.grace_period_seconds !== undefined) {
		updates.push("grace_period_seconds = ?");
		values.push(parseGrace(body.grace_period_seconds));
	}
	if (body.alert_webhook_url !== undefined) {
		updates.push("alert_webhook_url = ?");
		values.push(parseWebhookUrl(body.alert_webhook_url));
	}
	if (body.paused !== undefined) {
		if (typeof body.paused !== "boolean") {
			throw new HTTPException(400, { message: "paused must be a boolean." });
		}
		updates.push("status = ?");
		// Un-pausing returns to 'pending' until the next ping proves it alive.
		values.push(body.paused ? "paused" : monitor.last_ping_at === null ? "pending" : "ok");
	}

	if (updates.length === 0) {
		throw new HTTPException(400, {
			message:
				"Nothing to update. Supported fields: name, expected_interval_seconds, grace_period_seconds, alert_webhook_url, paused.",
		});
	}

	updates.push("updated_at = ?");
	values.push(nowSeconds(), monitor.id);

	await c.env.DB.prepare(`UPDATE monitors SET ${updates.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	const updated = await findMonitor(c.env.DB, c.get("user").id, slug);
	return c.json({ monitor: serializeMonitor(updated) });
});

monitors.delete("/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const monitor = await findMonitor(c.env.DB, c.get("user").id, slug);

	// D1 does not enforce ON DELETE CASCADE unless foreign keys are on, so
	// children are removed explicitly.
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM ping_logs WHERE monitor_id = ?").bind(monitor.id),
		c.env.DB.prepare("DELETE FROM monitor_events WHERE monitor_id = ?").bind(monitor.id),
		c.env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(monitor.id),
	]);

	return c.json({ deleted: slug });
});

export default monitors;
