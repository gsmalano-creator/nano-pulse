import { HTTPException } from "hono/http-exception";
import { newId } from "./ids";
import { generateApiKey, keyPrefix, sha256Hex } from "./keys";
import { nowSeconds } from "./time";
import type { AppBindings } from "../types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export interface ProvisionedUser extends IssuedKey {
	email: string;
	user_id: string;
	/** false when the email already existed and only a new key was added. */
	user_created: boolean;
}

/** Creates the user if needed, then issues a key. Idempotent on the email. */
export async function provisionUser(
	env: AppBindings,
	email: string,
	keyName: string,
): Promise<ProvisionedUser> {
	const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string }>();

	let userId = existing?.id;
	if (!userId) {
		userId = newId("usr");
		await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
			.bind(userId, email, nowSeconds())
			.run();
	}

	const issued = await issueApiKey(env, userId, keyName);
	return { ...issued, email, user_id: userId, user_created: existing === null };
}
