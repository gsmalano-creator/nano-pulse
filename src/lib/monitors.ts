import { HTTPException } from "hono/http-exception";
import { toIso } from "./time";
import type { MonitorRow } from "../types";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const MAX_GRACE_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const DEFAULT_INTERVAL_SECONDS = 3600;
export const DEFAULT_GRACE_SECONDS = 300;

/** Slugs are case-insensitive; we normalise to lowercase before storing. */
export function parseSlug(raw: string | undefined): string {
	const slug = (raw ?? "").trim().toLowerCase();
	if (!SLUG_PATTERN.test(slug)) {
		throw new HTTPException(400, {
			message:
				"Invalid slug. Use 1-63 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit.",
		});
	}
	return slug;
}

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

export function parseWebhookUrl(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "alert_webhook_url must be a string." });
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new HTTPException(400, { message: "alert_webhook_url must be a valid URL." });
	}
	if (url.protocol !== "https:") {
		throw new HTTPException(400, { message: "alert_webhook_url must use https." });
	}
	return url.toString();
}

export function parseName(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "name must be a string." });
	}
	const name = value.trim().slice(0, 120);
	return name === "" ? null : name;
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
