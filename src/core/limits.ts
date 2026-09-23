import { HTTPException } from "hono/http-exception";
import type { AppBindings, UserRow } from "../types";

/**
 * One number per user covers both products: a monitor and a schedule are both
 * "a thing we watch or run for you". Keeping a single quota means a plan is
 * still just an integer on the user, and there is only one limit to explain.
 */
export interface QuotaUsage {
	monitors: number;
	schedules: number;
	used: number;
	limit: number;
	remaining: number;
}

export async function quotaUsage(env: AppBindings, user: UserRow): Promise<QuotaUsage> {
	const row = await env.DB.prepare(
		`SELECT (SELECT count(*) FROM monitors WHERE user_id = ?1) AS monitors,
		        (SELECT count(*) FROM schedules WHERE user_id = ?1) AS schedules`,
	)
		.bind(user.id)
		.first<{ monitors: number; schedules: number }>();

	const monitors = row?.monitors ?? 0;
	const schedules = row?.schedules ?? 0;
	const used = monitors + schedules;

	return {
		monitors,
		schedules,
		used,
		limit: user.monitor_limit,
		remaining: Math.max(0, user.monitor_limit - used),
	};
}

/**
 * Blocks creation once the user is at their limit. Deliberately only guards
 * creation: pings and scheduled runs for things that already exist must never
 * be rejected for quota reasons, or a billing change would silently stop a
 * customer's monitoring.
 */
export async function assertQuota(
	env: AppBindings,
	user: UserRow,
	kind: "monitor" | "schedule",
): Promise<void> {
	const usage = await quotaUsage(env, user);
	if (usage.remaining > 0) return;

	throw new HTTPException(403, {
		res: Response.json(
			{
				error: {
					code: "quota_exceeded",
					message: `Plan limit reached (${usage.used}/${usage.limit} monitors and schedules). Delete one or upgrade before adding another ${kind}.`,
					used: usage.used,
					limit: usage.limit,
					monitors: usage.monitors,
					schedules: usage.schedules,
				},
			},
			{ status: 403 },
		),
	});
}
