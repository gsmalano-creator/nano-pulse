import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { issueApiKey, parseKeyName } from "../lib/users";
import { nowSeconds, toIso } from "../lib/time";
import type { ApiKeyRow, AppEnv } from "../types";

const keys = new Hono<AppEnv>();

function serializeKey(row: ApiKeyRow) {
	return {
		id: row.id,
		name: row.name,
		// The full key is unrecoverable; the prefix is what identifies it afterwards.
		key_prefix: row.key_prefix,
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

/** Issues an additional key for the caller. Used for rotation. */
keys.post("/", async (c) => {
	let name = "API key";
	if (c.req.header("content-length") && c.req.header("content-length") !== "0") {
		try {
			const body = (await c.req.json()) as Record<string, unknown>;
			name = parseKeyName(body?.name);
		} catch {
			throw new HTTPException(400, { message: "Request body must be JSON." });
		}
	}

	const issued = await issueApiKey(c.env, c.get("user").id, name);
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
