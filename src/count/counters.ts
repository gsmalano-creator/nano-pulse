import { HTTPException } from "hono/http-exception";
import { toIso } from "../core/time";
import type { CounterRow } from "../types";

export const MAX_STEP = 1000;

export function parseStep(value: unknown): number {
	if (value === undefined || value === null || value === "") return 1;
	const step = typeof value === "string" ? Number(value) : value;
	if (typeof step !== "number" || !Number.isInteger(step) || step === 0 || Math.abs(step) > MAX_STEP) {
		throw new HTTPException(400, {
			message: `by must be a non-zero integer between -${MAX_STEP} and ${MAX_STEP}.`,
		});
	}
	return step;
}

export function parseValue(value: unknown): number {
	const next = typeof value === "string" ? Number(value) : value;
	if (typeof next !== "number" || !Number.isInteger(next)) {
		throw new HTTPException(400, { message: "value must be an integer." });
	}
	return next;
}

/**
 * Whether this counter is a sequence rather than a tally. Only read when a
 * counter is created; see the migration for why it cannot be changed later.
 *
 * Returns null when the caller did not say. That is not the same as `false`:
 * omitting it on an increment has to mean "use whatever this counter already
 * is", or a sequence could never be incremented without repeating the flag
 * forever.
 */
export function parseMonotonic(value: unknown): boolean | null {
	if (value === undefined || value === null || value === "") return null;
	if (value === true || value === "true" || value === 1 || value === "1") return true;
	if (value === false || value === "false" || value === 0 || value === "0") return false;
	throw new HTTPException(400, { message: "monotonic must be true or false." });
}

export function parseLabel(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "label must be a string." });
	}
	return value.trim().slice(0, 32) || null;
}

/** 12 300 -> "12.3k". Badges are small; exact numbers stop being readable. */
export function formatValue(value: number): string {
	const abs = Math.abs(value);
	if (abs < 1000) return String(value);
	if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}m`;
}

export function serializeCounter(counter: CounterRow, badgeBase: string) {
	return {
		name: counter.name,
		value: counter.value,
		monotonic: counter.monotonic === 1,
		label: counter.label,
		badge_url: `${badgeBase}/b/${counter.public_id}.svg`,
		json_url: `${badgeBase}/b/${counter.public_id}.json`,
		created_at: toIso(counter.created_at),
		updated_at: toIso(counter.updated_at),
	};
}
