import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { sha256Hex } from "./keys";
import { nowSeconds } from "./time";
import type { ApiKeyRow, AppEnv, UserRow } from "../types";

function bearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

/**
 * Resolves `Authorization: Bearer <api_key>` to a user. Only the SHA-256 hash of
 * the key is ever compared, so a database dump does not leak usable keys.
 */
export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
	const token = bearerToken(c.req.header("authorization"));
	if (!token) {
		throw new HTTPException(401, {
			message: "Missing API key. Send 'Authorization: Bearer <api_key>'.",
		});
	}

	const hash = await sha256Hex(token);
	const row = await c.env.DB.prepare(
		`SELECT k.id AS k_id, k.user_id, k.name, k.key_prefix, k.key_hash, k.created_at AS k_created_at,
		        k.last_used_at, k.revoked_at,
		        u.id AS u_id, u.email, u.created_at AS u_created_at
		   FROM api_keys k
		   JOIN users u ON u.id = k.user_id
		  WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
	)
		.bind(hash)
		.first<Record<string, unknown>>();

	if (!row) {
		throw new HTTPException(401, { message: "Invalid or revoked API key." });
	}

	const apiKey: ApiKeyRow = {
		id: row.k_id as string,
		user_id: row.user_id as string,
		name: (row.name as string | null) ?? null,
		key_prefix: row.key_prefix as string,
		key_hash: row.key_hash as string,
		created_at: row.k_created_at as number,
		last_used_at: (row.last_used_at as number | null) ?? null,
		revoked_at: null,
	};
	const user: UserRow = {
		id: row.u_id as string,
		email: row.email as string,
		created_at: row.u_created_at as number,
	};

	c.set("apiKey", apiKey);
	c.set("user", user);

	// Usage tracking must never delay or fail the request.
	c.executionCtx.waitUntil(
		c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
			.bind(nowSeconds(), apiKey.id)
			.run()
			.then(() => undefined)
			.catch((error) => console.error("failed to update last_used_at", error)),
	);

	await next();
});
