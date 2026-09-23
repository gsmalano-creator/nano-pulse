/**
 * Alert delivery, shared by every service. Nothing here knows what a monitor or
 * a schedule is.
 */

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Posts one alert. Shared by Pulse and Relay: the body is Slack-compatible
 * (`text` at the top level) with extra fields for generic consumers.
 * Returns whether the receiver acknowledged it with a 2xx.
 */
export async function postAlert(
	webhookUrl: string,
	eventType: "down" | "up",
	message: string,
	extra: Record<string, unknown> = {},
): Promise<boolean> {
	const icon = eventType === "down" ? "🔴" : "🟢";
	const body = { text: `${icon} ${message}`, event: eventType, ...extra };

	try {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
		if (!response.ok) {
			console.error(`alert webhook returned HTTP ${response.status}`);
			return false;
		}
		return true;
	} catch (error) {
		console.error("alert webhook failed", error);
		return false;
	}
}
