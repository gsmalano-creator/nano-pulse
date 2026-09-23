import { HTTPException } from "hono/http-exception";
import { newId } from "./ids";
import { nowSeconds } from "./time";
import type { AppBindings } from "../types";

/**
 * Rate limits for the one unauthenticated endpoint in the API. They live in D1
 * rather than in memory because Workers run in many places at once: a counter
 * in an isolate would reset on every cold start and never see the other edges.
 */
export const LIMITS = {
	perIpPerHour: 3,
	perIpPerDay: 5,
	/** A ceiling on the whole service, so a distributed attempt still has one. */
	globalPerHour: 60,
};

export interface RateVerdict {
	allowed: boolean;
	reason?: string;
	retryAfterSeconds?: number;
}

export async function checkSignupRate(
	env: AppBindings,
	ip: string | null,
): Promise<RateVerdict> {
	const now = nowSeconds();
	const row = await env.DB.prepare(
		`SELECT
		   (SELECT count(*) FROM signups WHERE ip = ?1 AND created_at > ?2) AS ip_hour,
		   (SELECT count(*) FROM signups WHERE ip = ?1 AND created_at > ?3) AS ip_day,
		   (SELECT count(*) FROM signups WHERE created_at > ?2) AS all_hour`,
	)
		.bind(ip, now - 3600, now - 86400)
		.first<{ ip_hour: number; ip_day: number; all_hour: number }>();

	if ((row?.ip_hour ?? 0) >= LIMITS.perIpPerHour) {
		return { allowed: false, reason: "Too many signups from this address in the last hour.", retryAfterSeconds: 3600 };
	}
	if ((row?.ip_day ?? 0) >= LIMITS.perIpPerDay) {
		return { allowed: false, reason: "Too many signups from this address today.", retryAfterSeconds: 86400 };
	}
	if ((row?.all_hour ?? 0) >= LIMITS.globalPerHour) {
		return { allowed: false, reason: "Signups are busy right now. Try again shortly.", retryAfterSeconds: 900 };
	}
	return { allowed: true };
}

export function tooManyRequests(verdict: RateVerdict): never {
	throw new HTTPException(429, {
		res: Response.json(
			{
				error: {
					code: "rate_limited",
					message: verdict.reason ?? "Too many requests.",
					retry_after_seconds: verdict.retryAfterSeconds,
				},
			},
			{
				status: 429,
				headers: { "retry-after": String(verdict.retryAfterSeconds ?? 3600) },
			},
		),
	});
}

export async function recordSignup(
	env: AppBindings,
	fields: { email: string; ip: string | null; userAgent: string | null; userId: string },
): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO signups (id, email, ip, user_agent, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(newId("sgn"), fields.email, fields.ip, fields.userAgent, fields.userId, nowSeconds())
		.run();
}
