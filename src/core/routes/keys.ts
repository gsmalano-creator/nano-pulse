import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseScope } from "../keys";
import { issueApiKey, parseKeyName } from "../users";
import { nowSeconds, toIso } from "../time";
import type { ApiKeyRow, AppEnv } from "../../types";

const keys = new Hono<AppEnv>();

function serializeKey(row: ApiKeyRow) {
	return {
		id: row.id,
		name: row.name,
		// The full key is unrecoverable; the prefix is what identifies it afterwards.
		key_prefix: row.key_prefix,
		scope: row.scope,
		created_at: toIso(row.created_at),
		last_used_at: toIso(row.last_used_at),
		revoked_at: toIso(row.revoked_at),
		active: row.revoked_at === null,
	};
}

keys.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
	)
		.bind(c.get("user").id)
		.all<ApiKeyRow>();

	return c.json({
		keys: (results ?? []).map(serializeKey),
		current_key_id: c.get("apiKey").id,
	});
});

/**
 * Issues an additional key for the caller: rotation, and read-only keys for
 * anything that should look but not touch.
 *
 * Reaching this route at all needs a write key, since it is a POST. That is the
 * property that makes the scope hold: a read key cannot mint itself a wider one.
 */
keys.post("/", async (c) => {
	let name = "API key";
	let scope = parseScope(undefined);
	if (c.req.header("content-length") && c.req.header("content-length") !== "0") {
		try {
			const body = (await c.req.json()) as Record<string, unknown>;
			name = parseKeyName(body?.name);
			scope = parseScope(body?.scope);
		} catch (error) {
			if (error instanceof HTTPException) throw error;
			throw new HTTPException(400, { message: "Request body must be JSON." });
		}
	}

	const issued = await issueApiKey(c.env, c.get("user").id, name, scope);
	return c.json({ ...issued, name }, 201);
});

keys.delete("/:id", async (c) => {
	const id = c.req.param("id");

	// Revoking the key you are authenticating with would lock you out of this
	// endpoint, so rotation has to happen in the other order.
	if (id === c.get("apiKey").id) {
		throw new HTTPException(409, {
			message:
				"Cannot revoke the key used for this request. Create a new key, then revoke this one with it.",
		});
	}

	const key = await c.env.DB.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?")
		.bind(id, c.get("user").id)
		.first<ApiKeyRow>();

	if (!key) {
		throw new HTTPException(404, { message: `No key with id '${id}'.` });
	}
	if (key.revoked_at !== null) {
		return c.json({ revoked: serializeKey(key), already_revoked: true });
	}

	const now = nowSeconds();
	await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(now, id).run();

	return c.json({ revoked: serializeKey({ ...key, revoked_at: now }), already_revoked: false });
});

export default keys;
