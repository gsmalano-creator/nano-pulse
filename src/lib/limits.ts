import { HTTPException } from "hono/http-exception";
import type { AppBindings, UserRow } from "../types";

export interface MonitorUsage {
	used: number;
	limit: number;
	remaining: number;
}

export async function monitorUsage(env: AppBindings, user: UserRow): Promise<MonitorUsage> {
	const row = await env.DB.prepare("SELECT count(*) AS used FROM monitors WHERE user_id = ?")
		.bind(user.id)
		.first<{ used: number }>();

	const used = row?.used ?? 0;
	return { used, limit: user.monitor_limit, remaining: Math.max(0, user.monitor_limit - used) };
}

/**
 * Blocks creation of a new monitor once the user is at their limit. Deliberately
 * only guards creation: pings to monitors that already exist must never be
 * rejected for quota reasons, or a quota change would silently stop a customer's
 * monitoring.
 */
export async function assertMonitorQuota(env: AppBindings, user: UserRow): Promise<void> {
	const usage = await monitorUsage(env, user);
	if (usage.remaining > 0) return;

	throw new HTTPException(403, {
		res: Response.json(
			{
				error: {
					code: "monitor_limit_reached",
					message: `Monitor limit reached (${usage.used}/${usage.limit}). Delete a monitor or upgrade to add more.`,
					used: usage.used,
					limit: usage.limit,
				},
			},
			{ status: 403 },
		),
	});
}
