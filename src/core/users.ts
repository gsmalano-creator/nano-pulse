import { HTTPException } from "hono/http-exception";
import { newId } from "./ids";
import { generateApiKey, keyPrefix, sha256Hex } from "./keys";
import { nowSeconds } from "./time";
import type { AppBindings } from "../types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors the column default in migration 0002. */
export const DEFAULT_MONITOR_LIMIT = 5;

export function parseEmail(value: unknown): string {
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "email must be a string." });
	}
	const email = value.trim().toLowerCase();
	if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
		throw new HTTPException(400, { message: "email must be a valid email address." });
	}
	return email;
}

export function parseKeyName(value: unknown): string {
	if (value === undefined || value === null || value === "") return "API key";
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "name must be a string." });
	}
	return value.trim().slice(0, 80) || "API key";
}

export interface IssuedKey {
	/** Plaintext key. Only ever returned once, never stored. */
	api_key: string;
	key_id: string;
	key_prefix: string;
}

/** Mints a key for an existing user and stores only its hash. */
export async function issueApiKey(
	env: AppBindings,
	userId: string,
	name: string,
	environment: "live" | "test" = "live",
): Promise<IssuedKey> {
	const apiKey = generateApiKey(environment);
	const keyId = newId("key");

	await env.DB.prepare(
		`INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(keyId, userId, name, keyPrefix(apiKey), await sha256Hex(apiKey), nowSeconds())
		.run();

	return { api_key: apiKey, key_id: keyId, key_prefix: keyPrefix(apiKey) };
}

export function parseMonitorLimit(value: unknown): number {
	const limit = typeof value === "string" ? Number(value) : value;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 1_000_000) {
		throw new HTTPException(400, {
			message: "monitor_limit must be an integer between 0 and 1000000.",
		});
	}
	return limit;
}

export interface ProvisionedUser extends IssuedKey {
	email: string;
	user_id: string;
	monitor_limit: number;
	/** false when the email already existed and only a new key was added. */
	user_created: boolean;
}

/** Creates the user if needed, then issues a key. Idempotent on the email. */
export async function provisionUser(
	env: AppBindings,
	email: string,
	keyName: string,
	monitorLimit?: number,
): Promise<ProvisionedUser> {
	const existing = await env.DB.prepare("SELECT id, monitor_limit FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string; monitor_limit: number }>();

	let userId = existing?.id;
	// An existing user keeps their quota unless a new one is given explicitly.
	let limit = existing?.monitor_limit ?? monitorLimit ?? DEFAULT_MONITOR_LIMIT;

	if (!userId) {
		userId = newId("usr");
		await env.DB.prepare(
			"INSERT INTO users (id, email, created_at, monitor_limit) VALUES (?, ?, ?, ?)",
		)
			.bind(userId, email, nowSeconds(), limit)
			.run();
	} else if (monitorLimit !== undefined && monitorLimit !== existing?.monitor_limit) {
		limit = monitorLimit;
		await env.DB.prepare("UPDATE users SET monitor_limit = ? WHERE id = ?").bind(limit, userId).run();
	}

	const issued = await issueApiKey(env, userId, keyName);
	return {
		...issued,
		email,
		user_id: userId,
		monitor_limit: limit,
		user_created: existing === null,
	};
}

/** Changes a customer's quota. Returns null when the email is unknown. */
export async function setMonitorLimit(
	env: AppBindings,
	email: string,
	monitorLimit: number,
): Promise<{ email: string; user_id: string; monitor_limit: number } | null> {
	const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string }>();
	if (!user) return null;

	await env.DB.prepare("UPDATE users SET monitor_limit = ? WHERE id = ?")
		.bind(monitorLimit, user.id)
		.run();

	return { email, user_id: user.id, monitor_limit: monitorLimit };
}
