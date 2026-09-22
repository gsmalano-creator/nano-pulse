import { nowSeconds } from "./time";
import type { MonitorRow } from "../types";

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Records a state transition and, when a webhook is configured, delivers it.
 * The webhook body is Slack-compatible (`text`) with extra fields for generic
 * consumers. Delivery failures are logged but never thrown: the event row is
 * the source of truth and keeps `notified = 0` so it is visible as undelivered.
 */
export async function recordEvent(
	env: Env,
	monitor: MonitorRow,
	eventType: "down" | "up",
	message: string,
): Promise<void> {
	const inserted = await env.DB.prepare(
		`INSERT INTO monitor_events (monitor_id, event_type, message, created_at)
		 VALUES (?, ?, ?, ?)
		 RETURNING id`,
	)
		.bind(monitor.id, eventType, message, nowSeconds())
		.first<{ id: number }>();

	if (!monitor.alert_webhook_url || !inserted) return;

	const delivered = await deliverWebhook(monitor, eventType, message);
	if (delivered) {
		await env.DB.prepare("UPDATE monitor_events SET notified = 1 WHERE id = ?")
			.bind(inserted.id)
			.run();
	}
}

async function deliverWebhook(
	monitor: MonitorRow,
	eventType: "down" | "up",
	message: string,
): Promise<boolean> {
	const icon = eventType === "down" ? "🔴" : "🟢";
	const body = {
		text: `${icon} ${message}`,
		event: eventType,
		monitor: monitor.slug,
		monitor_name: monitor.name,
		expected_interval_seconds: monitor.expected_interval_seconds,
		grace_period_seconds: monitor.grace_period_seconds,
		service: "nanopulse",
	};

	try {
		const response = await fetch(monitor.alert_webhook_url as string, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
		if (!response.ok) {
			console.error(`webhook for ${monitor.slug} returned HTTP ${response.status}`);
			return false;
		}
		return true;
	} catch (error) {
		console.error(`webhook for ${monitor.slug} failed`, error);
		return false;
	}
}
