import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_MONITOR_LIMIT, parseEmail, parseKeyName, provisionUser } from "../users";
import { checkSignupRate, recordSignup, tooManyRequests } from "../signup";
import type { AppEnv } from "../../types";

const signup = new Hono<AppEnv>();

/**
 * The only endpoint that needs no API key — it is how you get one. Deliberately
 * without email verification: the key is the credential, the address is a label
 * and a way to reach you. Abuse is bounded by rate limits, not by a click.
 */
signup.post("/", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		throw new HTTPException(400, { message: "Request body must be JSON, e.g. {\"email\":\"you@example.com\"}" });
	}
	const input = (body ?? {}) as Record<string, unknown>;
	const email = parseEmail(input.email);

	const ip = c.req.header("cf-connecting-ip") ?? null;
	const verdict = await checkSignupRate(c.env, ip);
	if (!verdict.allowed) tooManyRequests(verdict);

	const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
		.bind(email)
		.first<{ id: string }>();
	if (existing) {
		throw new HTTPException(409, {
			res: Response.json(
				{
					error: {
						code: "already_registered",
						message:
							"That address already has an account. Use your existing key, or POST /v1/keys with it to issue another.",
					},
				},
				{ status: 409 },
			),
		});
	}

	const provisioned = await provisionUser(c.env, email, parseKeyName(input.name));
	await recordSignup(c.env, {
		email,
		ip,
		userAgent: c.req.header("user-agent")?.slice(0, 256) ?? null,
		userId: provisioned.user_id,
	});

	return c.json(
		{
			api_key: provisioned.api_key,
			key_prefix: provisioned.key_prefix,
			email: provisioned.email,
			quota: DEFAULT_MONITOR_LIMIT,
			note: "Store this key now — only its hash is kept, so it cannot be shown again.",
			docs: "https://nano-api.com/howto/",
		},
		201,
	);
});

export default signup;
