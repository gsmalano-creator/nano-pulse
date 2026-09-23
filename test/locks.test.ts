import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_TTL_SECONDS,
	MAX_TTL_SECONDS,
	parseOwner,
	parseToken,
	parseTtl,
	serializeLock,
} from "../src/lock/locks.ts";

const row = {
	id: "lck_1",
	user_id: "usr_1",
	name: "nightly-import",
	token: "secret-token",
	owner: "pod-a",
	fence: 7,
	acquired_at: 1_000_000,
	expires_at: 1_000_060,
};

test("ttl accepts sane values and rejects the rest", () => {
	assert.equal(parseTtl(undefined), DEFAULT_TTL_SECONDS);
	assert.equal(parseTtl(""), DEFAULT_TTL_SECONDS);
	assert.equal(parseTtl("30"), 30);
	assert.equal(parseTtl(MAX_TTL_SECONDS), MAX_TTL_SECONDS);
	for (const bad of [0, -1, 1.5, MAX_TTL_SECONDS + 1, "abc", {}]) {
		assert.throws(() => parseTtl(bad), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("owner is optional and bounded", () => {
	assert.equal(parseOwner(undefined), null);
	assert.equal(parseOwner("  pod-a  "), "pod-a");
	assert.equal(parseOwner("x".repeat(200))?.length, 120);
	assert.throws(() => parseOwner(42));
});

test("a token must be a non-empty string", () => {
	assert.equal(parseToken(" abc "), "abc");
	for (const bad of [undefined, "", "   ", 5]) {
		assert.throws(() => parseToken(bad));
	}
});

test("serialising never exposes the token", () => {
	const held = serializeLock(row, row.expires_at - 1);
	assert.equal(held.held, true);
	assert.equal(held.owner, "pod-a");
	assert.ok(!Object.values(held).includes("secret-token"));
	assert.ok(!("token" in held));
});

test("an expired row reads as free but keeps its fence", () => {
	const free = serializeLock(row, row.expires_at + 1);
	assert.equal(free.held, false);
	assert.equal(free.owner, null);
	assert.equal(free.expires_at, null);
	// The counter is what makes a fencing token useful; it must survive.
	assert.equal(free.fence, 7);
});
