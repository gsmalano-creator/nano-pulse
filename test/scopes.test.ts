import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY_SCOPES, parseScope, scopeAllowsMethod } from "../src/core/keys.ts";

test("scope defaults to write, so an omitted field cannot silently downgrade a key", () => {
	assert.equal(parseScope(undefined), "write");
	assert.equal(parseScope(null), "write");
	assert.equal(parseScope("write"), "write");
	assert.equal(parseScope("read"), "read");
});

test("anything that is not a known scope is rejected at the door", () => {
	for (const bad of ["admin", "READ", "", "readwrite", 1, true, {}, []]) {
		assert.throws(() => parseScope(bad), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("a read key may read and nothing else", () => {
	for (const method of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
		assert.equal(scopeAllowsMethod("read", method), true, `${method} should be allowed`);
	}
	for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
		assert.equal(scopeAllowsMethod("read", method), false, `${method} should be refused`);
	}
});

test("a write key may do everything", () => {
	for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
		assert.equal(scopeAllowsMethod("write", method), true);
	}
});

test("an unrecognised scope is treated as read-only, not as full access", () => {
	// A value this build does not know about must never grant more than the
	// narrowest scope: a future migration or a hand-edited row cannot escalate.
	for (const unknown of ["admin", "owner", "", "WRITE"]) {
		assert.equal(scopeAllowsMethod(unknown, "GET"), true);
		assert.equal(scopeAllowsMethod(unknown, "DELETE"), false);
	}
});

test("a read key cannot mint a wider key, because issuing one is a POST", () => {
	// The escalation path worth naming: POST /v1/keys is the only way to create
	// a key, and the same gate that blocks every other write blocks it too.
	assert.equal(scopeAllowsMethod("read", "POST"), false);
	assert.equal(scopeAllowsMethod("read", "DELETE"), false);
});

test("the advertised scopes are exactly the ones the parser accepts", () => {
	for (const scope of KEY_SCOPES) assert.equal(parseScope(scope), scope);
	assert.equal(KEY_SCOPES.length, 2);
});
