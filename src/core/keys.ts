import { HTTPException } from "hono/http-exception";

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

/**
 * A key is either read-only or full access. Scope is fixed at creation: a key
 * that could widen its own scope would not be a scope.
 */
export type KeyScope = "read" | "write";

export const KEY_SCOPES: readonly KeyScope[] = ["read", "write"];

export function parseScope(value: unknown): KeyScope {
	if (value === undefined || value === null) return "write";
	if (value === "read" || value === "write") return value;
	throw new HTTPException(400, { message: "scope must be 'read' or 'write'." });
}

/**
 * Every read in this API is a GET and every write is not, so the HTTP method is
 * the whole test. Deliberately method-based rather than a list of paths: a new
 * write route is then protected the day it is added, instead of the day someone
 * remembers to add it to a list.
 *
 * Fails closed. Anything that is not exactly "write" is treated as read-only,
 * so a scope value this build does not recognise cannot grant more than it
 * should.
 */
export function scopeAllowsMethod(scope: string, method: string): boolean {
	const upper = method.toUpperCase();
	if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return true;
	return scope === "write";
}
