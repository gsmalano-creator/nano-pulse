import { Hono } from "hono";
import { parseEmail, parseKeyName, provisionUser } from "../lib/users";
import type { AppEnv } from "../types";

const admin = new Hono<AppEnv>();

/**
 * Provisions a customer: creates the user (or reuses the email) and returns a
 * fresh API key. The plaintext key is in the response and nowhere else, so it
 * must be handed to the customer from here.
 */
admin.post("/users", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: { code: "bad_request", message: "Request body must be JSON." } },
			400,
		);
	}
	const input = (body ?? {}) as Record<string, unknown>;

	const provisioned = await provisionUser(
		c.env,
		parseEmail(input.email),
		parseKeyName(input.name),
	);

	return c.json(provisioned, 201);
});

export default admin;
