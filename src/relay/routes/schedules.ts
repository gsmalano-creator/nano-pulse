import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { newId } from "../../core/ids";
import { assertQuota } from "../../core/limits";
import { parseName, parseSlug, parseWebhookUrl } from "../../core/validation";
import { executeSchedule } from "../runner";
import {
	computeNextRun,
	parseCronExpression,
	parseHeaders,
	parseMaxAttempts,
	parseMethod,
	parseRequestBody,
	parseTimeout,
	parseTimezone,
	serializeSchedule,
} from "../schedules";
import { nowSeconds, toIso } from "../../core/time";
import { validateTargetUrl } from "../url-guard";
import type { AppEnv, ScheduleRow, ScheduleRunRow } from "../../types";

const RECENT_LIMIT = 20;

const schedules = new Hono<AppEnv>();

async function readJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
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

async function findSchedule(c: Context<AppEnv>, slug: string): Promise<ScheduleRow> {
	const schedule = await c.env.DB.prepare("SELECT * FROM schedules WHERE user_id = ? AND slug = ?")
		.bind(c.get("user").id, slug)
		.first<ScheduleRow>();
	if (!schedule) {
		throw new HTTPException(404, { message: `No schedule with slug '${slug}'.` });
	}
	return schedule;
}

function serializeRun(run: ScheduleRunRow) {
	return {
		started_at: toIso(run.started_at),
		scheduled_for: toIso(run.scheduled_for),
		outcome: run.outcome,
		status_code: run.status_code,
		duration_ms: run.duration_ms,
		attempts: run.attempts,
		triggered_by: run.triggered_by,
		error: run.error,
		response_excerpt: run.response_excerpt,
	};
}

schedules.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM schedules WHERE user_id = ? ORDER BY slug ASC",
	)
		.bind(c.get("user").id)
		.all<ScheduleRow>();

	return c.json({ schedules: (results ?? []).map(serializeSchedule) });
});

schedules.post("/", async (c) => {
	const body = await readJsonBody(c);
	const slug = parseSlug(body.slug as string | undefined);
	const user = c.get("user");

	const existing = await c.env.DB.prepare("SELECT id FROM schedules WHERE user_id = ? AND slug = ?")
		.bind(user.id, slug)
		.first<{ id: string }>();
	if (existing) {
		throw new HTTPException(409, {
			message: `Schedule '${slug}' already exists. Use PATCH to change it.`,
		});
	}

	await assertQuota(c.env, user, "schedule");

	const cron = parseCronExpression(body.cron);
	const timezone = parseTimezone(body.timezone);
	const url = await validateTargetUrl(c.env, body.url);
	const now = nowSeconds();
	const nextRunAt = computeNextRun(cron, timezone, now);
	if (nextRunAt === null) {
		throw new HTTPException(400, {
			message: "That cron expression has no next run within five years.",
		});
	}

	await c.env.DB.prepare(
		`INSERT INTO schedules (id, user_id, slug, name, cron, timezone, url, method, headers, body,
		                        timeout_seconds, max_attempts, alert_webhook_url, next_run_at,
		                        created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			newId("sch"),
			user.id,
			slug,
			parseName(body.name),
			cron,
			timezone,
			url,
			parseMethod(body.method),
			parseHeaders(body.headers),
			parseRequestBody(body.body),
			parseTimeout(body.timeout_seconds),
			parseMaxAttempts(body.max_attempts),
			parseWebhookUrl(body.alert_webhook_url),
			nextRunAt,
			now,
			now,
		)
		.run();

	return c.json({ schedule: serializeSchedule(await findSchedule(c, slug)) }, 201);
});

schedules.get("/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const schedule = await findSchedule(c, slug);

	const { results } = await c.env.DB.prepare(
		"SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
	)
		.bind(schedule.id, RECENT_LIMIT)
		.all<ScheduleRunRow>();

	return c.json({
		schedule: serializeSchedule(schedule),
		recent_runs: (results ?? []).map(serializeRun),
	});
});

schedules.patch("/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const schedule = await findSchedule(c, slug);
	const body = await readJsonBody(c);

	const updates: string[] = [];
	const values: unknown[] = [];
	const push = (column: string, value: unknown) => {
		updates.push(`${column} = ?`);
		values.push(value);
	};

	let cron = schedule.cron;
	let timezone = schedule.timezone;
	let rescheduleNeeded = false;

	if (body.cron !== undefined) {
		cron = parseCronExpression(body.cron);
		push("cron", cron);
		rescheduleNeeded = true;
	}
	if (body.timezone !== undefined) {
		timezone = parseTimezone(body.timezone);
		push("timezone", timezone);
		rescheduleNeeded = true;
	}
	if (body.url !== undefined) push("url", await validateTargetUrl(c.env, body.url));
	if (body.name !== undefined) push("name", parseName(body.name));
	if (body.method !== undefined) push("method", parseMethod(body.method));
	if (body.headers !== undefined) push("headers", parseHeaders(body.headers));
	if (body.body !== undefined) push("body", parseRequestBody(body.body));
	if (body.timeout_seconds !== undefined) push("timeout_seconds", parseTimeout(body.timeout_seconds));
	if (body.max_attempts !== undefined) push("max_attempts", parseMaxAttempts(body.max_attempts));
	if (body.alert_webhook_url !== undefined) {
		push("alert_webhook_url", parseWebhookUrl(body.alert_webhook_url));
	}
	if (body.paused !== undefined) {
		if (typeof body.paused !== "boolean") {
			throw new HTTPException(400, { message: "paused must be a boolean." });
		}
		push("paused", body.paused ? 1 : 0);
		// Resuming needs a fresh slot; pausing leaves the old one harmlessly behind.
		if (!body.paused) rescheduleNeeded = true;
	}

	if (updates.length === 0) {
		throw new HTTPException(400, {
			message:
				"Nothing to update. Supported fields: cron, timezone, url, name, method, headers, body, timeout_seconds, max_attempts, alert_webhook_url, paused.",
		});
	}

	const now = nowSeconds();
	if (rescheduleNeeded) {
		const nextRunAt = computeNextRun(cron, timezone, now);
		if (nextRunAt === null) {
			throw new HTTPException(400, {
				message: "That cron expression has no next run within five years.",
			});
		}
		push("next_run_at", nextRunAt);
	}
	push("updated_at", now);
	values.push(schedule.id);

	await c.env.DB.prepare(`UPDATE schedules SET ${updates.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();

	return c.json({ schedule: serializeSchedule(await findSchedule(c, slug)) });
});

schedules.delete("/:slug", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const schedule = await findSchedule(c, slug);

	// D1 does not enforce ON DELETE CASCADE unless foreign keys are on.
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM schedule_runs WHERE schedule_id = ?").bind(schedule.id),
		c.env.DB.prepare("DELETE FROM schedules WHERE id = ?").bind(schedule.id),
	]);

	return c.json({ deleted: slug });
});

/** Run now, without touching the schedule's own clock. Useful while setting up. */
schedules.post("/:slug/run", async (c) => {
	const slug = parseSlug(c.req.param("slug"));
	const schedule = await findSchedule(c, slug);

	const result = await executeSchedule(c.env, schedule, {
		scheduledFor: null,
		triggeredBy: "manual",
		advanceSchedule: false,
	});

	return c.json({ run: result, schedule: serializeSchedule(await findSchedule(c, slug)) });
});

export default schedules;
