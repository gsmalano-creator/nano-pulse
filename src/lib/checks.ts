import { recordEvent } from "./alerts";
import { nowSeconds } from "./time";
import type { MonitorRow } from "../types";

/** Safety valve so a single cron run cannot blow the Worker's time budget. */
const MAX_MONITORS_PER_RUN = 500;

export interface CheckSummary {
	checked_at: string;
	monitors_marked_down: number;
	slugs: string[];
}

export interface CheckOptions {
	now?: number;
	/** Limits the sweep to one user; used by the manual HTTP trigger. */
	userId?: string;
}

/**
 * Finds monitors that missed their window (last ping + interval + grace is in
 * the past), marks them down and emits a `down` event for each. Called by the
 * cron trigger, and exposed over HTTP for manual/debug runs.
 */
export async function runDueChecks(env: Env, options: CheckOptions = {}): Promise<CheckSummary> {
	const now = options.now ?? nowSeconds();
	const { results } = await env.DB.prepare(
		`SELECT * FROM monitors
		  WHERE status NOT IN ('down', 'paused')
		    AND last_ping_at IS NOT NULL
		    AND last_ping_at + expected_interval_seconds + grace_period_seconds <= ?
		    AND (? IS NULL OR user_id = ?)
		  ORDER BY last_ping_at ASC
		  LIMIT ?`,
	)
		.bind(now, options.userId ?? null, options.userId ?? null, MAX_MONITORS_PER_RUN)
		.all<MonitorRow>();

	const overdue = results ?? [];

	if (overdue.length > 0) {
		await env.DB.batch(
			overdue.map((monitor) =>
				env.DB.prepare("UPDATE monitors SET status = 'down', updated_at = ? WHERE id = ?").bind(
					now,
					monitor.id,
				),
			),
		);
	}

	const notifications = await Promise.allSettled(
		overdue.map((monitor) => {
			const lateBy = now - (monitor.last_ping_at as number);
			return recordEvent(
				env,
				monitor,
				"down",
				`Monitor '${monitor.slug}' has not pinged for ${lateBy}s (expected every ${monitor.expected_interval_seconds}s + ${monitor.grace_period_seconds}s grace).`,
			);
		}),
	);

	for (const result of notifications) {
		if (result.status === "rejected") {
			console.error("failed to record down event", result.reason);
		}
	}

	return {
		checked_at: new Date(now * 1000).toISOString(),
		monitors_marked_down: overdue.length,
		slugs: overdue.map((monitor) => monitor.slug),
	};
}
