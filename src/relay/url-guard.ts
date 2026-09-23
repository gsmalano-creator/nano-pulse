import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "../types";

/**
 * The customer chooses the URL we call, which makes Relay an SSRF and abuse
 * vector if left open. Two layers guard it:
 *
 *   1. Shape: https only, no credentials, no obviously-local hostname, and any
 *      IP literal must be public.
 *   2. Resolution: the hostname is resolved over DoH and every answer must be a
 *      public address. This runs before each execution as well as at write
 *      time, because DNS can be repointed at 10.x after the schedule is created.
 *
 * RELAY_ALLOW_PRIVATE_TARGETS disables both for local development. It is set in
 * .dev.vars and must never be set in production.
 */

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export class UnsafeTargetError extends Error {}

function isPrivateIPv4(ip: string): boolean {
	const octets = ip.split(".").map(Number);
	if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
		return true; // Not parseable as IPv4: treat as unsafe.
	}
	const [a, b] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) || // link-local, incl. cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 192 && b === 0) ||
		a === 198 && (b === 18 || b === 19) ||
		a >= 224 // multicast and reserved
	);
}

function isPrivateIPv6(ip: string): boolean {
	const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
	if (lower === "::1" || lower === "::") return true;
	if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
	// IPv4-mapped (::ffff:10.0.0.1)
	const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
	if (mapped) return isPrivateIPv4(mapped[1]);
	return false;
}

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Cheap checks that need no network. Throws UnsafeTargetError. */
export function assertSafeTargetShape(rawUrl: string, allowPrivate: boolean): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new UnsafeTargetError("url must be a valid absolute URL.");
	}

	if (allowPrivate) return url;

	if (url.protocol !== "https:") {
		throw new UnsafeTargetError("url must use https.");
	}
	if (url.username || url.password) {
		throw new UnsafeTargetError("url must not contain credentials.");
	}

	const host = url.hostname.toLowerCase();
	if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
		throw new UnsafeTargetError(`url host '${url.hostname}' is not a public address.`);
	}
	if (IPV4_PATTERN.test(host) && isPrivateIPv4(host)) {
		throw new UnsafeTargetError(`url host '${url.hostname}' is a private address.`);
	}
	if (host.includes(":") && isPrivateIPv6(host)) {
		throw new UnsafeTargetError(`url host '${url.hostname}' is a private address.`);
	}

	return url;
}

interface DohAnswer {
	type: number;
	data: string;
}

/** Resolves over DoH and rejects any private answer. */
export async function assertPublicResolution(
	hostname: string,
	allowPrivate: boolean,
): Promise<void> {
	if (allowPrivate) return;
	if (IPV4_PATTERN.test(hostname) || hostname.includes(":")) return; // already checked as a literal

	const addresses: string[] = [];
	for (const type of ["A", "AAAA"]) {
		const response = await fetch(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
			{ headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) },
		);
		if (!response.ok) {
			throw new UnsafeTargetError(`could not resolve '${hostname}' to verify it is public.`);
		}
		const body = (await response.json()) as { Answer?: DohAnswer[] };
		for (const answer of body.Answer ?? []) {
			// 1 = A, 28 = AAAA; CNAMEs (5) are followed by the resolver itself.
			if (answer.type === 1 || answer.type === 28) addresses.push(answer.data);
		}
	}

	if (addresses.length === 0) {
		throw new UnsafeTargetError(`'${hostname}' has no public address.`);
	}
	for (const address of addresses) {
		const isPrivate = address.includes(":") ? isPrivateIPv6(address) : isPrivateIPv4(address);
		if (isPrivate) {
			throw new UnsafeTargetError(`'${hostname}' resolves to a private address (${address}).`);
		}
	}
}

export function allowsPrivateTargets(env: AppBindings): boolean {
	return env.RELAY_ALLOW_PRIVATE_TARGETS === "true";
}

/** Write-time validation, surfaced as a 400. */
export async function validateTargetUrl(env: AppBindings, rawUrl: unknown): Promise<string> {
	if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
		throw new HTTPException(400, { message: "url is required." });
	}
	const allowPrivate = allowsPrivateTargets(env);
	try {
		const url = assertSafeTargetShape(rawUrl.trim(), allowPrivate);
		await assertPublicResolution(url.hostname, allowPrivate);
		return url.toString();
	} catch (error) {
		if (error instanceof UnsafeTargetError) {
			throw new HTTPException(400, { message: error.message });
		}
		throw error;
	}
}
