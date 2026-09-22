const KEY_PREFIX_LENGTH = 12;

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates a key of the form np_live_<40 hex chars>. */
export function generateApiKey(environment: "live" | "test" = "live"): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const random = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `np_${environment}_${random}`;
}

/** The safe-to-display part of a key. */
export function keyPrefix(key: string): string {
	return key.slice(0, KEY_PREFIX_LENGTH);
}
