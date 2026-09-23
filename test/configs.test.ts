import assert from "node:assert/strict";
import { test } from "node:test";
import {
	etagFor,
	MAX_KEYS,
	mergeDocument,
	parseDocument,
	parseIfMatch,
	parseKey,
} from "../src/config/configs.ts";

test("a document must be a JSON object with usable keys", () => {
	assert.deepEqual(parseDocument({ maintenance: true }), { maintenance: true });
	assert.deepEqual(parseDocument({}), {});
	for (const bad of [null, [], "text", 5, { "bad key": 1 }, { "": 1 }, { ["a".repeat(65)]: 1 }]) {
		assert.throws(() => parseDocument(bad as never), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("documents are bounded in keys and bytes", () => {
	const tooManyKeys = Object.fromEntries(
		Array.from({ length: MAX_KEYS + 1 }, (_, i) => [`k${i}`, 1]),
	);
	assert.throws(() => parseDocument(tooManyKeys));
	assert.throws(() => parseDocument({ big: "x".repeat(40_000) }));
});

test("If-Match accepts the shapes a client actually sends", () => {
	assert.equal(parseIfMatch('"7"'), 7);
	assert.equal(parseIfMatch("7"), 7);
	assert.equal(parseIfMatch('W/"7"'), 7);
	// No header, or the wildcard, means an unconditional write.
	assert.equal(parseIfMatch(undefined), null);
	assert.equal(parseIfMatch("*"), null);
	assert.throws(() => parseIfMatch('"abc"'));
});

test("etag tracks the version", () => {
	assert.equal(etagFor(1), '"1"');
	assert.notEqual(etagFor(1), etagFor(2));
});

test("merging sets keys and null removes them", () => {
	const current = { maintenance: false, banner: "hi", max_items: 50 };
	assert.deepEqual(mergeDocument(current, { maintenance: true }), {
		maintenance: true,
		banner: "hi",
		max_items: 50,
	});
	assert.deepEqual(mergeDocument(current, { banner: null }), {
		maintenance: false,
		max_items: 50,
	});
	// The original is untouched: callers hold the pre-write document for the
	// conflict message.
	assert.deepEqual(current, { maintenance: false, banner: "hi", max_items: 50 });
});

test("keys are validated the same way in the path as in the document", () => {
	assert.equal(parseKey("feature.new-checkout"), "feature.new-checkout");
	for (const bad of [undefined, "", "has space", "-leading"]) {
		assert.throws(() => parseKey(bad));
	}
});
