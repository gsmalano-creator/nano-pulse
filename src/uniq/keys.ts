import { HTTPException } from "hono/http-exception";
import { toIso } from "../core/time";
import type { AppBindings, UniqKeyRow } from "../types";
import { nowSeconds } from "../core/time";

/** A day. Long enough for webhook retry windows, short enough to expire. */
export const DEFAULT_TTL_SECONDS = 86_400;
export const MIN_TTL_SECONDS = 1;
export const MAX_TTL_SECONDS = 30 * 24 * 3600;

/**
 * How many live keys one account may hold. Enforced by the sweep rather than
 * on the request path: a check per call would double the cost of the cheapest
 * operation here, and a minute of lag on a ceiling nobody should reach is a
 * better trade than latency on every call.
 */
export const MAX_LIVE_KEYS = 50_000;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Keys come from somewhere else -- Stripe, a queue, an order table -- so this
 * is deliberately permissive about shape and strict about length. Colons are
 * allowed because `customer:42:welcome-email` is how people namespace them.
 */
export function parseKey(raw: string | undefined): string {
	const key = (raw ?? "").trim();
	if (!KEY_PATTERN.test(key)) {
		throw new HTTPException(400, {
			message:
				"Key must be 1-200 characters of letters, digits, dot, underscore, colon or hyphen, starting with a letter or digit.",
		});
	}
	return key;
}

export function parseTtl(value: unknown): number {
	if (value === undefined || value === null || value === "") return DEFAULT_TTL_SECONDS;
	const ttl = typeof value === "string" ? Number(value) : value;
	if (
		typeof ttl !== "number" ||
		!Number.isInteger(ttl) ||
		ttl < MIN_TTL_SECONDS ||
		ttl > MAX_TTL_SECONDS
	) {
		throw new HTTPException(400, {
			message: `ttl must be a whole number of seconds between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}.`,
		});
	}
	return ttl;
}

export function serializeUniqKey(row: UniqKeyRow) {
	return {
		key: row.key,
		first_time: row.hits === 1,
		hits: row.hits,
		first_seen_at: toIso(row.first_seen_at),
		expires_at: toIso(row.expires_at),
	};
}

/**
 * Deletes expired rows, then trims any account over the live cap oldest-first.
 * Both are housekeeping: expiry is already honoured on read, so nothing here
 * changes an answer, it only stops dead rows accumulating.
 */
export async function purgeUniqKeys(env: AppBindings): Promise<number> {
	const expired = await env.DB.prepare("DELETE FROM uniq_keys WHERE expires_at <= ?")
		.bind(nowSeconds())
		.run();

	const { results } = await env.DB.prepare(
		`SELECT user_id, COUNT(*) AS live FROM uniq_keys GROUP BY user_id HAVING live > ?`,
	)
		.bind(MAX_LIVE_KEYS)
		.all<{ user_id: string; live: number }>();

	let trimmed = 0;
	for (const row of results ?? []) {
		const over = row.live - MAX_LIVE_KEYS;
		const result = await env.DB.prepare(
			`DELETE FROM uniq_keys WHERE id IN (
			   SELECT id FROM uniq_keys WHERE user_id = ? ORDER BY first_seen_at ASC LIMIT ?
			 )`,
		)
			.bind(row.user_id, over)
			.run();
		trimmed += result.meta.changes ?? 0;
	}

	return (expired.meta.changes ?? 0) + trimmed;
}
