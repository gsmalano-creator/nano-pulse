import { HTTPException } from "hono/http-exception";
import { toIso } from "../core/time";
import type { MonitorRow } from "../types";

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const MAX_GRACE_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const DEFAULT_INTERVAL_SECONDS = 3600;
export const DEFAULT_GRACE_SECONDS = 300;

function parseSeconds(value: unknown, field: string, min: number, max: number): number {
	const seconds = typeof value === "string" ? Number(value) : value;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || !Number.isInteger(seconds)) {
		throw new HTTPException(400, { message: `${field} must be an integer number of seconds.` });
	}
	if (seconds < min || seconds > max) {
		throw new HTTPException(400, { message: `${field} must be between ${min} and ${max} seconds.` });
	}
	return seconds;
}

export function parseInterval(value: unknown): number {
	return parseSeconds(value, "expected_interval_seconds", MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
}

export function parseGrace(value: unknown): number {
	return parseSeconds(value, "grace_period_seconds", 0, MAX_GRACE_SECONDS);
}

/** The moment a monitor is considered late (interval + grace after last ping). */
export function dueAt(monitor: MonitorRow): number | null {
	if (monitor.last_ping_at === null) return null;
	return monitor.last_ping_at + monitor.expected_interval_seconds + monitor.grace_period_seconds;
}

export function serializeMonitor(monitor: MonitorRow) {
	const nextExpected =
		monitor.last_ping_at === null ? null : monitor.last_ping_at + monitor.expected_interval_seconds;

	return {
		slug: monitor.slug,
		name: monitor.name,
		status: monitor.status,
		expected_interval_seconds: monitor.expected_interval_seconds,
		grace_period_seconds: monitor.grace_period_seconds,
		last_ping_at: toIso(monitor.last_ping_at),
		next_ping_expected_by: toIso(nextExpected),
		alert_due_at: toIso(dueAt(monitor)),
		alert_webhook_configured: monitor.alert_webhook_url !== null,
		created_at: toIso(monitor.created_at),
		updated_at: toIso(monitor.updated_at),
	};
}
