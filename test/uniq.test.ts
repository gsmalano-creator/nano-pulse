import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_TTL_SECONDS,
	MAX_TTL_SECONDS,
	parseKey,
	parseTtl,
	serializeUniqKey,
} from "../src/uniq/keys.ts";

const row = (over: Partial<Parameters<typeof serializeUniqKey>[0]> = {}) => ({
	id: "unq_1",
	user_id: "usr_1",
	key: "evt_1",
	first_seen_at: 1_700_000_000,
	expires_at: 1_700_086_400,
	hits: 1,
	...over,
});

test("the caller's key is accepted in the shapes other systems actually use", () => {
	// Stripe, GitHub deliveries, and hand-namespaced keys.
	for (const key of [
		"evt_1JK2nX8sABCdef",
		"a",
		"customer:42:welcome-email",
		"order.2026-09-25.0001",
		"A1-b2_c3",
		"x".repeat(200),
	]) {
		assert.equal(parseKey(key), key);
	}
	assert.equal(parseKey("  evt_1  "), "evt_1", "surrounding whitespace is trimmed");
});

test("keys that would be ambiguous or unbounded are refused", () => {
	for (const bad of [undefined, "", "   ", "-leading", ".leading", "has space", "sla/sh", "x".repeat(201)]) {
		assert.throws(() => parseKey(bad as string), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("ttl defaults to a day and stays inside its bounds", () => {
	assert.equal(parseTtl(undefined), DEFAULT_TTL_SECONDS);
	assert.equal(parseTtl(""), DEFAULT_TTL_SECONDS);
	assert.equal(parseTtl("60"), 60);
	assert.equal(parseTtl(1), 1);
	assert.equal(parseTtl(MAX_TTL_SECONDS), MAX_TTL_SECONDS);
	for (const bad of [0, -1, 1.5, MAX_TTL_SECONDS + 1, "soon", {}]) {
		assert.throws(() => parseTtl(bad), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("first_time is decided by the hit count, never by a timestamp", () => {
	// Two arrivals in the same second would both match first_seen_at === now.
	// Counting is the only way to tell them apart, and telling them apart is
	// the entire guarantee.
	assert.equal(serializeUniqKey(row({ hits: 1 })).first_time, true);
	assert.equal(serializeUniqKey(row({ hits: 2 })).first_time, false);
	assert.equal(serializeUniqKey(row({ hits: 99 })).first_time, false);
});

test("the serialized key reports the window it is claiming", () => {
	const seen = serializeUniqKey(row());
	assert.equal(seen.key, "evt_1");
	assert.equal(seen.hits, 1);
	assert.equal(seen.first_seen_at, "2023-11-14T22:13:20.000Z");
	assert.equal(seen.expires_at, "2023-11-15T22:13:20.000Z");
});
