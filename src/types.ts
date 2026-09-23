export type MonitorStatus = "pending" | "ok" | "down" | "paused";

export interface UserRow {
	id: string;
	email: string;
	created_at: number;
	/** Maximum number of monitors this user may create. */
	monitor_limit: number;
}

export interface ApiKeyRow {
	id: string;
	user_id: string;
	name: string | null;
	key_prefix: string;
	key_hash: string;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

export interface MonitorRow {
	id: string;
	user_id: string;
	slug: string;
	name: string | null;
	expected_interval_seconds: number;
	grace_period_seconds: number;
	status: MonitorStatus;
	last_ping_at: number | null;
	alert_webhook_url: string | null;
	created_at: number;
	updated_at: number;
}

export interface PingLogRow {
	id: number;
	monitor_id: string;
	received_at: number;
	reported_status: "ok" | "fail";
	source_ip: string | null;
	user_agent: string | null;
	payload: string | null;
}

export interface MonitorEventRow {
	id: number;
	monitor_id: string;
	event_type: "down" | "up";
	message: string | null;
	notified: number;
	created_at: number;
}

export interface ScheduleRow {
	id: string;
	user_id: string;
	slug: string;
	name: string | null;
	cron: string;
	timezone: string;
	url: string;
	method: "GET" | "POST";
	headers: string | null;
	body: string | null;
	timeout_seconds: number;
	max_attempts: number;
	paused: number;
	alert_webhook_url: string | null;
	next_run_at: number | null;
	last_run_at: number | null;
	last_status: "ok" | "failed" | null;
	consecutive_failures: number;
	created_at: number;
	updated_at: number;
}

export interface ConfigRow {
	id: string;
	user_id: string;
	name: string;
	/** JSON object, serialised. */
	data: string;
	version: number;
	created_at: number;
	updated_at: number;
}

export interface ConfigRevisionRow {
	id: number;
	config_id: string;
	version: number;
	data: string;
	note: string | null;
	created_at: number;
}

export interface LockRow {
	id: string;
	user_id: string;
	name: string;
	token: string;
	owner: string | null;
	fence: number;
	acquired_at: number;
	expires_at: number;
}

export type RunOutcome = "ok" | "http_error" | "timeout" | "network_error" | "blocked";

export interface ScheduleRunRow {
	id: number;
	schedule_id: string;
	started_at: number;
	scheduled_for: number | null;
	attempts: number;
	outcome: RunOutcome;
	status_code: number | null;
	duration_ms: number | null;
	response_excerpt: string | null;
	error: string | null;
	triggered_by: "schedule" | "manual";
}

/**
 * `Env` is generated from wrangler.json and covers the D1 binding. ADMIN_TOKEN is
 * a secret set with `wrangler secret put` (or .dev.vars locally), so it is not in
 * the generated types and is declared here instead. Optional on purpose: the admin
 * routes refuse to serve when it is missing rather than falling open.
 */
export type AppBindings = Env & {
	ADMIN_TOKEN?: string;
	/** Dev-only escape hatch for Relay target validation; never set in production. */
	RELAY_ALLOW_PRIVATE_TARGETS?: string;
};

/** Hono generics: bindings plus the authenticated caller. */
export type AppEnv = {
	Bindings: AppBindings;
	Variables: {
		user: UserRow;
		apiKey: ApiKeyRow;
	};
};
