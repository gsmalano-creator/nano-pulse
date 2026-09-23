import { HTTPException } from "hono/http-exception";
import { toIso } from "../core/time";
import type { ConfigRow } from "../types";

export const MAX_DOCUMENT_BYTES = 32 * 1024;
export const MAX_KEYS = 200;
export const KEPT_REVISIONS = 20;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A config is always a flat-topped JSON object; values may be anything JSON. */
export function parseDocument(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new HTTPException(400, { message: "A config document must be a JSON object." });
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_KEYS) {
		throw new HTTPException(400, { message: `A config may hold at most ${MAX_KEYS} keys.` });
	}
	for (const [key] of entries) {
		if (!KEY_PATTERN.test(key)) {
			throw new HTTPException(400, {
				message: `Invalid key '${key}'. Use letters, digits, '.', '_' or '-', up to 64 characters.`,
			});
		}
	}

	const serialized = JSON.stringify(value);
	if (new TextEncoder().encode(serialized).length > MAX_DOCUMENT_BYTES) {
		throw new HTTPException(400, {
			message: `A config document must be at most ${MAX_DOCUMENT_BYTES} bytes.`,
		});
	}
	return value as Record<string, unknown>;
}

export function parseKey(raw: string | undefined): string {
	const key = (raw ?? "").trim();
	if (!KEY_PATTERN.test(key)) {
		throw new HTTPException(400, { message: `Invalid key '${raw}'.` });
	}
	return key;
}

export function parseNote(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") {
		throw new HTTPException(400, { message: "note must be a string." });
	}
	return value.trim().slice(0, 200) || null;
}

/**
 * Optimistic concurrency. `If-Match: "7"` means "only write if the document is
 * still at version 7", which is how two writers stop silently clobbering each
 * other. A missing header means an unconditional write.
 */
export function parseIfMatch(header: string | undefined): number | null {
	if (!header || header.trim() === "" || header.trim() === "*") return null;
	const match = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
	if (!match) {
		throw new HTTPException(400, {
			message: 'If-Match must be a version, for example: If-Match: "7"',
		});
	}
	return Number(match[1]);
}

export function etagFor(version: number): string {
	return `"${version}"`;
}

/** Shallow merge. A key set to null is removed, which is how you unset a flag. */
export function mergeDocument(
	current: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

export function documentOf(config: ConfigRow): Record<string, unknown> {
	return JSON.parse(config.data) as Record<string, unknown>;
}

export function serializeConfig(config: ConfigRow) {
	return {
		name: config.name,
		version: config.version,
		data: documentOf(config),
		created_at: toIso(config.created_at),
		updated_at: toIso(config.updated_at),
	};
}
