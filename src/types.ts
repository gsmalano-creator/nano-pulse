export type MonitorStatus = "pending" | "ok" | "down" | "paused";

export interface UserRow {
	id: string;
	email: string;
	created_at: number;
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

/** Hono generics: D1 binding plus the authenticated caller. */
export type AppEnv = {
	Bindings: Env;
	Variables: {
		user: UserRow;
		apiKey: ApiKeyRow;
	};
};
