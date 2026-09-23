import { HTTPException } from "hono/http-exception";
import { newId } from "../core/ids";
import { nowSeconds, toIso } from "../core/time";
import type { AppBindings, LockRow, UserRow } from "../types";

export const DEFAULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 3600;
/**
 * Locks are ephemeral, so they do not count against the monitor/schedule quota
 * — that quota is for things we watch or run on your behalf. This is only an
 * abuse ceiling on distinct names.
 */
export const MAX_LOCKS_PER_USER = 100;

export function parseTtl(value: unknown): number {
	if (value === undefined || value === null || value === "") return DEFAULT_TTL_SECONDS;
	const ttl = typeof value === "string" ? Number(value) : value;
	if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
		throw new HTTPException(400, {
			message: `ttl must be an integer between 1 and ${MAX_TTL_SECONDS} seconds.`,
		});
	}
	return ttl;
}

export function parseOwner(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "owner must be a string." });
	}
	return value.trim().slice(0, 120) || null;
}

export function parseToken(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new HTTPException(400, { message: "token is required and must be a string." });
	}
	return value.trim();
}

export interface AcquireResult {
	acquired: boolean;
	token?: string;
	fence?: number;
	expires_at: number;
	owner: string | null;
}

/**
 * Acquire, as one atomic statement. The upsert only overwrites a row whose
 * lease has already expired, so two simultaneous callers cannot both win: SQLite
 * applies the write on the primary, and the loser's `RETURNING` comes back empty.
 */
export async function acquire(
	env: AppBindings,
	user: UserRow,
	name: string,
	ttlSeconds: number,
	owner: string | null,
): Promise<AcquireResult> {
	const now = nowSeconds();
	const token = crypto.randomUUID();

	const won = await env.DB.prepare(
		`INSERT INTO locks (id, user_id, name, token, owner, fence, acquired_at, expires_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
		 ON CONFLICT (user_id, name) DO UPDATE SET
		     token = excluded.token,
		     owner = excluded.owner,
		     fence = locks.fence + 1,
		     acquired_at = excluded.acquired_at,
		     expires_at = excluded.expires_at
		   WHERE locks.expires_at <= excluded.acquired_at
		 RETURNING token, fence, expires_at, owner`,
	)
		.bind(newId("lck"), user.id, name, token, owner, now, now + ttlSeconds)
		.first<{ token: string; fence: number; expires_at: number; owner: string | null }>();

	if (won) {
		return {
			acquired: true,
			token: won.token,
			fence: won.fence,
			expires_at: won.expires_at,
			owner: won.owner,
		};
	}

	// Somebody else holds it; report until when, without leaking their token.
	const held = await env.DB.prepare(
		"SELECT expires_at, owner FROM locks WHERE user_id = ? AND name = ?",
	)
		.bind(user.id, name)
		.first<{ expires_at: number; owner: string | null }>();

	return {
		acquired: false,
		expires_at: held?.expires_at ?? now,
		owner: held?.owner ?? null,
	};
}

export async function countLocks(env: AppBindings, user: UserRow): Promise<number> {
	const row = await env.DB.prepare("SELECT count(*) AS n FROM locks WHERE user_id = ?")
		.bind(user.id)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function lockExists(
	env: AppBindings,
	user: UserRow,
	name: string,
): Promise<boolean> {
	const row = await env.DB.prepare("SELECT 1 AS x FROM locks WHERE user_id = ? AND name = ?")
		.bind(user.id, name)
		.first<{ x: number }>();
	return row !== null;
}

/**
 * Release is token-scoped: only the current holder can let go. The row is
 * expired rather than deleted, because `fence` must never go backwards — a
 * deleted row would restart the counter at 1 and a resource tracking the
 * highest fence it has seen would then reject the legitimate new holder.
 * The token is blanked so nothing can match it afterwards.
 */
export async function release(
	env: AppBindings,
	user: UserRow,
	name: string,
	token: string,
): Promise<boolean> {
	const released = await env.DB.prepare(
		`UPDATE locks SET expires_at = ?, token = '', owner = NULL
		  WHERE user_id = ? AND name = ? AND token = ? AND expires_at > ?
		 RETURNING name`,
	)
		.bind(nowSeconds(), user.id, name, token, nowSeconds())
		.first<{ name: string }>();
	return released !== null;
}

export async function renew(
	env: AppBindings,
	user: UserRow,
	name: string,
	token: string,
	ttlSeconds: number,
): Promise<{ expires_at: number; fence: number } | null> {
	const now = nowSeconds();
	const row = await env.DB.prepare(
		`UPDATE locks SET expires_at = ?
		  WHERE user_id = ? AND name = ? AND token = ? AND expires_at > ?
		 RETURNING expires_at, fence`,
	)
		.bind(now + ttlSeconds, user.id, name, token, now)
		.first<{ expires_at: number; fence: number }>();
	return row;
}

export async function status(
	env: AppBindings,
	user: UserRow,
	name: string,
): Promise<LockRow | null> {
	return env.DB.prepare("SELECT * FROM locks WHERE user_id = ? AND name = ?")
		.bind(user.id, name)
		.first<LockRow>();
}

/** A row whose lease has run out is free, whether or not it has been swept. */
export function serializeLock(lock: LockRow, now: number = nowSeconds()) {
	const held = lock.expires_at > now;
	return {
		name: lock.name,
		held,
		owner: held ? lock.owner : null,
		fence: lock.fence,
		acquired_at: held ? toIso(lock.acquired_at) : null,
		expires_at: held ? toIso(lock.expires_at) : null,
	};
}

/**
 * Housekeeping only: expiry is evaluated on read, not by this sweep. Rows are
 * kept for a month after last use so the fence counter survives normal
 * acquire/release cycles; a name unused for that long starts over at 1.
 */
export async function purgeExpiredLocks(
	env: AppBindings,
	olderThanSeconds = 30 * 24 * 3600,
): Promise<number> {
	const result = await env.DB.prepare("DELETE FROM locks WHERE expires_at < ?")
		.bind(nowSeconds() - olderThanSeconds)
		.run();
	return result.meta.changes ?? 0;
}
