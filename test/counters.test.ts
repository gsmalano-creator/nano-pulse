import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBadge } from "../src/count/badge.ts";
import { formatValue, MAX_STEP, parseLabel, parseStep, parseValue } from "../src/count/counters.ts";

test("the step is a bounded, non-zero integer", () => {
	assert.equal(parseStep(undefined), 1);
	assert.equal(parseStep("5"), 5);
	assert.equal(parseStep(-3), -3);
	for (const bad of [0, 1.5, MAX_STEP + 1, -MAX_STEP - 1, "abc", {}]) {
		assert.throws(() => parseStep(bad), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("an exact value may be zero or negative, but not fractional", () => {
	assert.equal(parseValue(0), 0);
	assert.equal(parseValue("-12"), -12);
	assert.throws(() => parseValue(1.5));
	assert.throws(() => parseValue("many"));
});

test("labels are optional and trimmed to badge size", () => {
	assert.equal(parseLabel(undefined), null);
	assert.equal(parseLabel("  downloads "), "downloads");
	assert.equal(parseLabel("x".repeat(80))?.length, 32);
});

test("large numbers shorten so the badge stays readable", () => {
	assert.equal(formatValue(0), "0");
	assert.equal(formatValue(999), "999");
	assert.equal(formatValue(1500), "1.5k");
	assert.equal(formatValue(12_300), "12k");
	assert.equal(formatValue(2_400_000), "2.4m");
	assert.equal(formatValue(24_000_000), "24m");
	assert.equal(formatValue(-42), "-42");
});

test("the badge is valid SVG and escapes what it is given", () => {
	const svg = renderBadge("downloads", 12_300, "green");
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	assert.match(svg, /<\/svg>$/);
	assert.ok(svg.includes(">12k<"));
	assert.ok(svg.includes("#35d399"));

	// A label is caller-controlled and ends up inside markup.
	const nasty = renderBadge('"><script>alert(1)</script>', 1, "green");
	assert.ok(!nasty.includes("<script>"));
	assert.ok(nasty.includes("&lt;script&gt;"));
});

test("an unknown colour falls back rather than breaking the image", () => {
	assert.ok(renderBadge("x", 1, "chartreuse").includes("#35d399"));
	assert.ok(renderBadge("x", 1, "amber").includes("#fbbf5c"));
});
