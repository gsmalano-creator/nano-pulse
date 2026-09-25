import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { newId } from "../../core/ids";
import { assertQuota } from "../../core/limits";
import { nowSeconds } from "../../core/time";
import { parseSlug } from "../../core/validation";
import { parseLabel, parseMonotonic, parseStep, parseValue, serializeCounter } from "../counters";
import type { AppEnv, CounterRow } from "../../types";

const counters = new Hono<AppEnv>();

/**
 * Badges always live on one host, whichever hostname the API was called on, so
 * a URL pasted into a README keeps working. Falls back to the request origin
 * in local development, where that host does not exist.
 */
function badgeBase(c: Context<AppEnv>): string {
	if (c.env.COUNT_BASE_URL) return c.env.COUNT_BASE_URL.replace(/\/$/, "");
	const url = new URL(c.req.url);
	return `${url.protocol}//${url.host}`;
}

async function optionalJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
	const length = c.req.header("content-length");
	if (!length || length === "0") return {};
	try {
		const body = await c.req.json();
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			throw new HTTPException(400, { message: "Request body must be a JSON object." });
		}
		return body as Record<string, unknown>;
	} catch (error) {
		if (error instanceof HTTPException) throw error;
		throw new HTTPException(400, { message: "Request body must be JSON." });
	}
}

async function find(c: Context<AppEnv>, name: string): Promise<CounterRow | null> {
	return c.env.DB.prepare("SELECT * FROM counters WHERE user_id = ? AND name = ?")
		.bind(c.get("user").id, name)
		.first<CounterRow>();
}

/**
 * The flag is immutable, so explicitly asking for a different one than the
 * counter was created with is a mistake worth naming rather than ignoring.
 * Saying nothing is not a mistake: it means "whatever this counter already is".
 * Reading it before the write is safe because it cannot change underneath us.
 */
function assertSameMode(existing: CounterRow | null, wanted: boolean | null): void {
	if (!existing || wanted === null) return;
	const isMonotonic = existing.monotonic === 1;
	if (isMonotonic === wanted) return;
	throw new HTTPException(409, {
		message: isMonotonic
			? `Counter '${existing.name}' was created monotonic and cannot be changed. Omit monotonic, or use a new name.`
			: `Counter '${existing.name}' was not created monotonic and cannot be changed now. Use a new name.`,
	});
}

/** Raised when the single atomic write declined to move the counter. */
async function refuseBackwards(
	c: Context<AppEnv>,
	name: string,
	attempted: string,
): Promise<never> {
	const current = await find(c, name);
	throw new HTTPException(409, {
		message: `Counter '${name}' is monotonic and only moves forward. It is at ${current?.value ?? "?"}; ${attempted} was refused.`,
	});
}

counters.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM counters WHERE user_id = ? ORDER BY name ASC",
	)
		.bind(c.get("user").id)
		.all<CounterRow>();

	return c.json({ counters: (results ?? []).map((row) => serializeCounter(row, badgeBase(c))) });
});

/**
 * Increment. One atomic upsert, so two simultaneous calls cannot read the same
 * value and write it back — the failure that makes hand-rolled counters wrong.
 */
counters.post("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const body = await optionalJson(c);
	const step = parseStep(body.by ?? c.req.query("by"));
	const label = parseLabel(body.label ?? c.req.query("label"));
	const now = nowSeconds();

	const monotonic = parseMonotonic(body.monotonic ?? c.req.query("monotonic"));

	const existing = await find(c, name);
	assertSameMode(existing, monotonic);
	if (!existing) await assertQuota(c.env, c.get("user"), "counter");

	// The guard is in the statement, not around it: a read-then-check would let
	// two concurrent calls both decide they were allowed.
	const row = await c.env.DB.prepare(
		`INSERT INTO counters (id, user_id, name, value, label, public_id, monotonic, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
		 ON CONFLICT (user_id, name) DO UPDATE SET
		     value = counters.value + excluded.value,
		     label = coalesce(excluded.label, counters.label),
		     updated_at = excluded.updated_at
		 WHERE counters.monotonic = 0 OR excluded.value > 0
		 RETURNING *`,
	)
		.bind(newId("cnt"), c.get("user").id, name, step, label, newId("pub"), monotonic === true ? 1 : 0, now)
		.first<CounterRow>();

	// No row means the WHERE declined it, which can only be a negative step on
	// a monotonic counter.
	if (!row) await refuseBackwards(c, name, `a step of ${step}`);

	return c.json({ counter: serializeCounter(row as CounterRow, badgeBase(c)) }, existing ? 200 : 201);
});

counters.get("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const counter = await find(c, name);
	if (!counter) throw new HTTPException(404, { message: `No counter named '${name}'.` });
	return c.json({ counter: serializeCounter(counter, badgeBase(c)) });
});

/** Set an exact value, for corrections and for seeding from an old system. */
counters.put("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const body = await optionalJson(c);
	const value = parseValue(body.value ?? c.req.query("value"));
	const label = parseLabel(body.label ?? c.req.query("label"));
	const now = nowSeconds();

	const monotonic = parseMonotonic(body.monotonic ?? c.req.query("monotonic"));

	const existing = await find(c, name);
	assertSameMode(existing, monotonic);
	if (!existing) await assertQuota(c.env, c.get("user"), "counter");

	const row = await c.env.DB.prepare(
		`INSERT INTO counters (id, user_id, name, value, label, public_id, monotonic, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
		 ON CONFLICT (user_id, name) DO UPDATE SET
		     value = excluded.value,
		     label = coalesce(excluded.label, counters.label),
		     updated_at = excluded.updated_at
		 WHERE counters.monotonic = 0 OR excluded.value > counters.value
		 RETURNING *`,
	)
		.bind(newId("cnt"), c.get("user").id, name, value, label, newId("pub"), monotonic === true ? 1 : 0, now)
		.first<CounterRow>();

	if (!row) await refuseBackwards(c, name, `setting it to ${value}`);

	return c.json({ counter: serializeCounter(row as CounterRow, badgeBase(c)) });
});

counters.delete("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const counter = await find(c, name);
	if (!counter) throw new HTTPException(404, { message: `No counter named '${name}'.` });
	await c.env.DB.prepare("DELETE FROM counters WHERE id = ?").bind(counter.id).run();
	return c.json({ deleted: name });
});

export default counters;
