import { HTTPException } from "hono/http-exception";
import { CronError, isValidTimeZone, nextRunFor, parseCron } from "./cron";
import { toIso } from "../core/time";
import type { ScheduleRow } from "../types";

export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_ATTEMPTS = 3;
export const MAX_BODY_BYTES = 8192;
const MAX_HEADERS = 10;

/** Headers a customer must not be able to set on our outbound request. */
const RESERVED_HEADERS = new Set([
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
	"cf-connecting-ip",
	"x-forwarded-for",
	"x-nanorelay-run-id",
	"x-nanorelay-schedule",
	"authorization",
]);

export function parseCronExpression(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new HTTPException(400, { message: "cron is required." });
	}
	const expression = value.trim().replace(/\s+/g, " ");
	try {
		parseCron(expression);
	} catch (error) {
		throw new HTTPException(400, {
			message: error instanceof CronError ? error.message : "Invalid cron expression.",
		});
	}
	return expression;
}

export function parseTimezone(value: unknown): string {
	if (value === undefined || value === null || value === "") return DEFAULT_TIMEZONE;
	if (typeof value !== "string" || !isValidTimeZone(value)) {
		throw new HTTPException(400, {
			message: "timezone must be an IANA name such as 'Europe/Oslo'.",
		});
	}
	return value;
}

export function parseMethod(value: unknown): "GET" | "POST" {
	if (value === undefined || value === null || value === "") return "POST";
	const method = String(value).toUpperCase();
	if (method !== "GET" && method !== "POST") {
		throw new HTTPException(400, { message: "method must be GET or POST." });
	}
	return method;
}

export function parseTimeout(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_TIMEOUT_SECONDS;
	const seconds = Number(value);
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
		throw new HTTPException(400, {
			message: `timeout_seconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}.`,
		});
	}
	return seconds;
}

export function parseMaxAttempts(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_MAX_ATTEMPTS;
	const attempts = Number(value);
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
		throw new HTTPException(400, {
			message: `max_attempts must be an integer between 1 and ${MAX_ATTEMPTS}.`,
		});
	}
	return attempts;
}

/** Request body sent to the customer's endpoint. Stored as given. */
export function parseRequestBody(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	const body = typeof value === "string" ? value : JSON.stringify(value);
	if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
		throw new HTTPException(400, { message: `body must be at most ${MAX_BODY_BYTES} bytes.` });
	}
	return body;
}

export function parseHeaders(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new HTTPException(400, { message: "headers must be a JSON object." });
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_HEADERS) {
		throw new HTTPException(400, { message: `headers may contain at most ${MAX_HEADERS} entries.` });
	}

	const cleaned: Record<string, string> = {};
	for (const [key, raw] of entries) {
		const name = key.trim().toLowerCase();
		if (!/^[a-z0-9-]+$/.test(name)) {
			throw new HTTPException(400, { message: `header name '${key}' is not valid.` });
		}
		if (RESERVED_HEADERS.has(name)) {
			throw new HTTPException(400, { message: `header '${key}' cannot be overridden.` });
		}
		if (typeof raw !== "string" || raw.length > 1024) {
			throw new HTTPException(400, { message: `header '${key}' must be a string under 1024 chars.` });
		}
		cleaned[name] = raw;
	}

	return Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
}

/** Next run for a schedule, or null when the expression can never match again. */
export function computeNextRun(
	cron: string,
	timezone: string,
	afterEpochSeconds: number,
): number | null {
	return nextRunFor(cron, timezone, afterEpochSeconds);
}

export function serializeSchedule(schedule: ScheduleRow) {
	return {
		slug: schedule.slug,
		name: schedule.name,
		cron: schedule.cron,
		timezone: schedule.timezone,
		url: schedule.url,
		method: schedule.method,
		headers: schedule.headers === null ? null : (JSON.parse(schedule.headers) as Record<string, string>),
		body: schedule.body,
		timeout_seconds: schedule.timeout_seconds,
		max_attempts: schedule.max_attempts,
		paused: schedule.paused === 1,
		alert_webhook_configured: schedule.alert_webhook_url !== null,
		next_run_at: toIso(schedule.next_run_at),
		last_run_at: toIso(schedule.last_run_at),
		last_status: schedule.last_status,
		consecutive_failures: schedule.consecutive_failures,
		created_at: toIso(schedule.created_at),
		updated_at: toIso(schedule.updated_at),
	};
}
