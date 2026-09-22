import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
	parseEmail,
	parseKeyName,
	parseMonitorLimit,
	provisionUser,
	setMonitorLimit,
} from "../lib/users";
import type { AppEnv } from "../types";

const admin = new Hono<AppEnv>();

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new HTTPException(400, { message: "Request body must be JSON." });
	}
	if (body !== null && typeof body === "object" && !Array.isArray(body)) {
		return body as Record<string, unknown>;
	}
	throw new HTTPException(400, { message: "Request body must be a JSON object." });
}

/**
 * Provisions a customer: creates the user (or reuses the email) and returns a
 * fresh API key. The plaintext key is in the response and nowhere else, so it
 * must be handed to the customer from here.
 */
admin.post("/users", async (c) => {
	const input = await readJson(c);

	const provisioned = await provisionUser(
		c.env,
		parseEmail(input.email),
		parseKeyName(input.name),
		input.monitor_limit === undefined ? undefined : parseMonitorLimit(input.monitor_limit),
	);

	return c.json(provisioned, 201);
});

/** Upgrades or downgrades a customer: the quota is the whole "plan". */
admin.patch("/users/:email", async (c) => {
	const email = parseEmail(c.req.param("email"));
	const input = await readJson(c);

	if (input.monitor_limit === undefined) {
		return c.json(
			{ error: { code: "bad_request", message: "Nothing to update. Supported field: monitor_limit." } },
			400,
		);
	}

	const updated = await setMonitorLimit(c.env, email, parseMonitorLimit(input.monitor_limit));
	if (!updated) {
		return c.json({ error: { code: "not_found", message: `No user with email '${email}'.` } }, 404);
	}

	return c.json(updated);
});

export default admin;
