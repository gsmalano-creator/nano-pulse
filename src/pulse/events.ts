import { postAlert } from "../core/alerts";
import { nowSeconds } from "../core/time";
import type { MonitorRow } from "../types";

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

function deliverWebhook(
	monitor: MonitorRow,
	eventType: "down" | "up",
	message: string,
): Promise<boolean> {
	return postAlert(monitor.alert_webhook_url as string, eventType, message, {
		monitor: monitor.slug,
		monitor_name: monitor.name,
		expected_interval_seconds: monitor.expected_interval_seconds,
		grace_period_seconds: monitor.grace_period_seconds,
		service: "nanopulse",
	});
}
