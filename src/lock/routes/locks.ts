import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { nowSeconds, toIso } from "../../core/time";
import { parseSlug } from "../../core/validation";
import {
	acquire,
	countLocks,
	DEFAULT_TTL_SECONDS,
	lockExists,
	MAX_LOCKS_PER_USER,
	parseOwner,
	parseTtl,
	parseToken,
	release,
	renew,
	serializeLock,
	status,
} from "../locks";
import type { AppEnv, LockRow } from "../../types";

const locks = new Hono<AppEnv>();

/** Body is optional on every route here: a lock call should fit in one curl. */
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

/** Token may come from the body or the query, whichever suits the caller. */
function tokenFrom(c: Context<AppEnv>, body: Record<string, unknown>): string {
	return parseToken(body.token ?? c.req.query("token"));
}

locks.get("/", async (c) => {
	const now = nowSeconds();
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM locks WHERE user_id = ? ORDER BY name ASC",
	)
		.bind(c.get("user").id)
		.all<LockRow>();

	return c.json({ locks: (results ?? []).map((lock) => serializeLock(lock, now)) });
});

/**
 * Acquire. Non-blocking by design: you get the lock or you get 409, and the
 * client decides whether to retry. No queue, no waiting connection.
 */
locks.post("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const body = await optionalJson(c);
	const user = c.get("user");

	const ttl = parseTtl(body.ttl ?? c.req.query("ttl"));
	const owner = parseOwner(body.owner ?? c.req.query("owner"));

	if (!(await lockExists(c.env, user, name)) && (await countLocks(c.env, user)) >= MAX_LOCKS_PER_USER) {
		throw new HTTPException(403, {
			res: Response.json(
				{
					error: {
						code: "lock_limit_reached",
						message: `You are using ${MAX_LOCKS_PER_USER} distinct lock names, which is the limit. Release or rename some.`,
					},
				},
				{ status: 403 },
			),
		});
	}

	const result = await acquire(c.env, user, name, ttl, owner);
	if (!result.acquired) {
		throw new HTTPException(409, {
			res: Response.json(
				{
					error: {
						code: "lock_held",
						message: `Lock '${name}' is held by someone else.`,
						held_until: toIso(result.expires_at),
						owner: result.owner,
					},
				},
				{ status: 409 },
			),
		});
	}

	return c.json(
		{
			acquired: true,
			name,
			token: result.token,
			fence: result.fence,
			ttl_seconds: ttl,
			expires_at: toIso(result.expires_at),
		},
		201,
	);
});

locks.get("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const lock = await status(c.env, c.get("user"), name);
	if (!lock) {
		return c.json({ name, held: false, owner: null, fence: 0, acquired_at: null, expires_at: null });
	}
	return c.json(serializeLock(lock));
});

/** Extend the lease. Long jobs should renew rather than ask for a huge TTL. */
locks.post("/:name/renew", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const body = await optionalJson(c);
	const token = tokenFrom(c, body);
	const ttl = parseTtl(body.ttl ?? c.req.query("ttl"));

	const renewed = await renew(c.env, c.get("user"), name, token, ttl);
	if (!renewed) {
		throw new HTTPException(409, {
			res: Response.json(
				{
					error: {
						code: "lock_not_yours",
						message: `Lock '${name}' is not held with that token — it expired, or someone else has it now.`,
					},
				},
				{ status: 409 },
			),
		});
	}

	return c.json({
		renewed: true,
		name,
		fence: renewed.fence,
		ttl_seconds: ttl,
		expires_at: toIso(renewed.expires_at),
	});
});

locks.delete("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const body = await optionalJson(c);
	const token = tokenFrom(c, body);

	if (await release(c.env, c.get("user"), name, token)) {
		return c.json({ released: true, name });
	}

	throw new HTTPException(409, {
		res: Response.json(
			{
				error: {
					code: "lock_not_yours",
					message: `Lock '${name}' is not held with that token — it expired, or someone else has it now.`,
				},
			},
			{ status: 409 },
		),
	});
});

export default locks;
