import { HTTPException } from "hono/http-exception";

/**
 * Validation shared by every service: a slug identifies a monitor or a
 * schedule, and both can carry a display name and an alert webhook.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Slugs are case-insensitive; we normalise to lowercase before storing. */
export function parseSlug(raw: string | undefined): string {
	const slug = (raw ?? "").trim().toLowerCase();
	if (!SLUG_PATTERN.test(slug)) {
		throw new HTTPException(400, {
			message:
				"Invalid slug. Use 1-63 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit.",
		});
	}
	return slug;
}

export function parseName(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "name must be a string." });
	}
	const name = value.trim().slice(0, 120);
	return name === "" ? null : name;
}

export function parseWebhookUrl(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "alert_webhook_url must be a string." });
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new HTTPException(400, { message: "alert_webhook_url must be a valid URL." });
	}
	if (url.protocol !== "https:") {
		throw new HTTPException(400, { message: "alert_webhook_url must use https." });
	}
	return url.toString();
}
