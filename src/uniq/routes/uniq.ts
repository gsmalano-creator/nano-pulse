import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { newId } from "../../core/ids";
import { nowSeconds } from "../../core/time";
import { parseKey, parseTtl, serializeUniqKey } from "../keys";
import type { AppEnv, UniqKeyRow } from "../../types";

const uniq = new Hono<AppEnv>();

/**
 * The whole product: has this key arrived before, inside its window?
 *
 * One statement decides it. A `SELECT` followed by an `INSERT` is the version
 * everyone writes by hand, and it is wrong: two deliveries arriving together
 * both see nothing and both proceed. Here the insert *is* the check.
 *
 * `hits` decides "first time", not a timestamp comparison. Two arrivals in the
 * same second would both match `first_seen_at = now`, and both would be told
 * they were first, which is the one answer this endpoint must never give twice.
 */
uniq.post("/:key", async (c) => {
	const key = parseKey(c.req.param("key"));
	const ttl = parseTtl(c.req.query("ttl"));
	const now = nowSeconds();
	const expires = now + ttl;

	const row = await c.env.DB.prepare(
		`INSERT INTO uniq_keys (id, user_id, key, first_seen_at, expires_at, hits)
		 VALUES (?1, ?2, ?3, ?4, ?5, 1)
		 ON CONFLICT (user_id, key) DO UPDATE SET
		     first_seen_at = CASE WHEN uniq_keys.expires_at <= ?4 THEN ?4 ELSE uniq_keys.first_seen_at END,
		     expires_at    = CASE WHEN uniq_keys.expires_at <= ?4 THEN ?5 ELSE uniq_keys.expires_at END,
		     hits          = CASE WHEN uniq_keys.expires_at <= ?4 THEN 1  ELSE uniq_keys.hits + 1 END
		 RETURNING *`,
	)
		.bind(newId("unq"), c.get("user").id, key, now, expires)
		.first<UniqKeyRow>();

	const seen = serializeUniqKey(row as UniqKeyRow);
	return c.json(seen, seen.first_time ? 201 : 200);
});

/** Look without claiming. Never changes anything, so it is safe for a read key. */
uniq.get("/:key", async (c) => {
	const key = parseKey(c.req.param("key"));
	const row = await c.env.DB.prepare(
		"SELECT * FROM uniq_keys WHERE user_id = ? AND key = ? AND expires_at > ?",
	)
		.bind(c.get("user").id, key, nowSeconds())
		.first<UniqKeyRow>();

	if (!row) return c.json({ key, seen: false }, 404);
	return c.json({ ...serializeUniqKey(row), seen: true, first_time: false });
});

/**
 * Forget a key, so the next arrival counts as first again. The escape hatch
 * for "the delivery failed after we claimed it" -- without it, a crash between
 * claiming and working means the work never happens.
 */
uniq.delete("/:key", async (c) => {
	const key = parseKey(c.req.param("key"));
	const result = await c.env.DB.prepare("DELETE FROM uniq_keys WHERE user_id = ? AND key = ?")
		.bind(c.get("user").id, key)
		.run();

	if ((result.meta.changes ?? 0) === 0) {
		throw new HTTPException(404, { message: `No live key '${key}'.` });
	}
	return c.json({ forgotten: key });
});

/** Recent keys, newest first. For looking at, not for iterating. */
uniq.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM uniq_keys WHERE user_id = ? AND expires_at > ?
		  ORDER BY first_seen_at DESC LIMIT 100`,
	)
		.bind(c.get("user").id, nowSeconds())
		.all<UniqKeyRow>();

	const rows = (results ?? []).map(serializeUniqKey);
	return c.json({ keys: rows.map((r) => ({ ...r, first_time: undefined })), limit: 100 });
});

export default uniq;
