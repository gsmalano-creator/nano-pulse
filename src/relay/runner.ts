import { postAlert } from "../core/alerts";
import { computeNextRun } from "./schedules";
import { nowSeconds } from "../core/time";
import {
	allowsPrivateTargets,
	assertPublicResolution,
	assertSafeTargetShape,
	UnsafeTargetError,
} from "./url-guard";
import type { AppBindings, RunOutcome, ScheduleRow } from "../types";

/** Keeps one sweep bounded; anything left over is picked up the next minute. */
const MAX_SCHEDULES_PER_SWEEP = 50;
const RETRY_BACKOFF_SECONDS = [2, 6];
const RESPONSE_EXCERPT_CHARS = 512;

export interface RunResult {
	outcome: RunOutcome;
	status_code: number | null;
	duration_ms: number;
	response_excerpt: string | null;
	error: string | null;
	attempts: number;
	run_id: string;
}

interface Attempt {
	outcome: RunOutcome;
	statusCode: number | null;
	durationMs: number;
	excerpt: string | null;
	error: string | null;
}

function sleep(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function attemptOnce(schedule: ScheduleRow, runId: string): Promise<Attempt> {
	const headers: Record<string, string> = {
		"user-agent": "NanoRelay/1.0 (+https://nano-api.com)",
		"x-nanorelay-run-id": runId,
		"x-nanorelay-schedule": schedule.slug,
	};
	if (schedule.headers) {
		Object.assign(headers, JSON.parse(schedule.headers) as Record<string, string>);
	}
	if (schedule.method === "POST" && schedule.body && !("content-type" in headers)) {
		headers["content-type"] = "application/json";
	}

	const startedAt = Date.now();
	try {
		const response = await fetch(schedule.url, {
			method: schedule.method,
			headers,
			body: schedule.method === "POST" ? (schedule.body ?? null) : undefined,
			signal: AbortSignal.timeout(schedule.timeout_seconds * 1000),
			redirect: "manual", // a redirect could point somewhere private
		});

		const text = await response.text().catch(() => "");
		const excerpt = text.slice(0, RESPONSE_EXCERPT_CHARS) || null;
		const durationMs = Date.now() - startedAt;

		if (response.ok) {
			return { outcome: "ok", statusCode: response.status, durationMs, excerpt, error: null };
		}
		return {
			outcome: "http_error",
			statusCode: response.status,
			durationMs,
			excerpt,
			error: `endpoint returned HTTP ${response.status}`,
		};
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			outcome: timedOut ? "timeout" : "network_error",
			statusCode: null,
			durationMs,
			excerpt: null,
			error: timedOut
				? `no response within ${schedule.timeout_seconds}s`
				: error instanceof Error
					? error.message
					: "request failed",
		};
	}
}

export interface ExecuteOptions {
	scheduledFor: number | null;
	triggeredBy: "schedule" | "manual";
	/** Manual runs must not move the schedule's own clock. */
	advanceSchedule: boolean;
}

/**
 * Calls the customer's endpoint, retries a failure up to `max_attempts`, stores
 * the run, and alerts on a change of state. Never throws: a failed run is data,
 * not an exception.
 */
export async function executeSchedule(
	env: AppBindings,
	schedule: ScheduleRow,
	options: ExecuteOptions,
): Promise<RunResult> {
	const runId = crypto.randomUUID();
	const startedAt = nowSeconds();
	const allowPrivate = allowsPrivateTargets(env);

	let attempt: Attempt;
	let attempts = 0;

	try {
		// Re-checked on every run: DNS can be repointed after creation.
		const url = assertSafeTargetShape(schedule.url, allowPrivate);
		await assertPublicResolution(url.hostname, allowPrivate);

		attempts = 1;
		attempt = await attemptOnce(schedule, runId);
		while (attempt.outcome !== "ok" && attempts < schedule.max_attempts) {
			await sleep(RETRY_BACKOFF_SECONDS[Math.min(attempts - 1, RETRY_BACKOFF_SECONDS.length - 1)]);
			attempts += 1;
			attempt = await attemptOnce(schedule, runId);
		}
	} catch (error) {
		attempts = Math.max(attempts, 1);
		attempt = {
			outcome: "blocked",
			statusCode: null,
			durationMs: 0,
			excerpt: null,
			error:
				error instanceof UnsafeTargetError
					? `target refused: ${error.message}`
					: error instanceof Error
						? error.message
						: "target check failed",
		};
	}

	const succeeded = attempt.outcome === "ok";
	const finishedAt = nowSeconds();
	const statements = [
		env.DB.prepare(
			`INSERT INTO schedule_runs (schedule_id, started_at, scheduled_for, attempts, outcome,
			                            status_code, duration_ms, response_excerpt, error, triggered_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			schedule.id,
			startedAt,
			options.scheduledFor,
			attempts,
			attempt.outcome,
			attempt.statusCode,
			attempt.durationMs,
			attempt.excerpt,
			attempt.error,
			options.triggeredBy,
		),
	];

	if (options.advanceSchedule) {
		// Advance from now, not from the missed slot: a backlog after an outage
		// should not replay every skipped run.
		const nextRunAt = computeNextRun(schedule.cron, schedule.timezone, finishedAt);
		statements.push(
			env.DB.prepare(
				`UPDATE schedules
				    SET last_run_at = ?, last_status = ?, consecutive_failures = ?, next_run_at = ?, updated_at = ?
				  WHERE id = ?`,
			).bind(
				finishedAt,
				succeeded ? "ok" : "failed",
				succeeded ? 0 : schedule.consecutive_failures + 1,
				nextRunAt,
				finishedAt,
				schedule.id,
			),
		);
	} else {
		statements.push(
			env.DB.prepare(
				`UPDATE schedules
				    SET last_run_at = ?, last_status = ?, consecutive_failures = ?, updated_at = ?
				  WHERE id = ?`,
			).bind(
				finishedAt,
				succeeded ? "ok" : "failed",
				succeeded ? 0 : schedule.consecutive_failures + 1,
				finishedAt,
				schedule.id,
			),
		);
	}

	await env.DB.batch(statements);

	// Only transitions are alert-worthy, same rule as Pulse.
	if (schedule.alert_webhook_url) {
		if (!succeeded && schedule.last_status !== "failed") {
			await postAlert(
				schedule.alert_webhook_url,
				"down",
				`Schedule '${schedule.slug}' failed: ${attempt.error} (${attempts} attempt${attempts === 1 ? "" : "s"}).`,
				{ schedule: schedule.slug, outcome: attempt.outcome, status_code: attempt.statusCode, service: "nanorelay" },
			);
		} else if (succeeded && schedule.last_status === "failed") {
			await postAlert(
				schedule.alert_webhook_url,
				"up",
				`Schedule '${schedule.slug}' is succeeding again (HTTP ${attempt.statusCode}).`,
				{ schedule: schedule.slug, outcome: "ok", status_code: attempt.statusCode, service: "nanorelay" },
			);
		}
	}

	return {
		outcome: attempt.outcome,
		status_code: attempt.statusCode,
		duration_ms: attempt.durationMs,
		response_excerpt: attempt.excerpt,
		error: attempt.error,
		attempts,
		run_id: runId,
	};
}

export interface SweepSummary {
	swept_at: string;
	schedules_run: number;
	succeeded: number;
	failed: number;
	slugs: string[];
}

/** Runs every schedule whose slot has passed. Called by the cron trigger. */
export async function runDueSchedules(
	env: AppBindings,
	now: number = nowSeconds(),
): Promise<SweepSummary> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM schedules
		  WHERE paused = 0
		    AND next_run_at IS NOT NULL
		    AND next_run_at <= ?
		  ORDER BY next_run_at ASC
		  LIMIT ?`,
	)
		.bind(now, MAX_SCHEDULES_PER_SWEEP)
		.all<ScheduleRow>();

	const due = results ?? [];
	const outcomes = await Promise.allSettled(
		due.map((schedule) =>
			executeSchedule(env, schedule, {
				scheduledFor: schedule.next_run_at,
				triggeredBy: "schedule",
				advanceSchedule: true,
			}),
		),
	);

	let succeeded = 0;
	let failed = 0;
	for (const [index, result] of outcomes.entries()) {
		if (result.status === "rejected") {
			failed += 1;
			console.error(`schedule ${due[index].slug} threw`, result.reason);
		} else if (result.value.outcome === "ok") {
			succeeded += 1;
		} else {
			failed += 1;
		}
	}

	return {
		swept_at: new Date(now * 1000).toISOString(),
		schedules_run: due.length,
		succeeded,
		failed,
		slugs: due.map((schedule) => schedule.slug),
	};
}
