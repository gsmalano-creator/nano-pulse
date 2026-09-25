import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBadge } from "../src/count/badge.ts";
import {
	formatValue,
	MAX_STEP,
	parseLabel,
	parseMonotonic,
	parseStep,
	parseValue,
	serializeCounter,
} from "../src/count/counters.ts";

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

test("monotonic is opt-in, and silence is not the same as false", () => {
	// Omitting it has to mean "leave this counter as it is", or an existing
	// sequence could never be incremented without repeating the flag.
	assert.equal(parseMonotonic(undefined), null);
	assert.equal(parseMonotonic(null), null);
	assert.equal(parseMonotonic(""), null);
	for (const yes of [true, "true", 1, "1"]) assert.equal(parseMonotonic(yes), true);
	for (const no of [false, "false", 0, "0"]) assert.equal(parseMonotonic(no), false);
	for (const bad of ["yes", "TRUE", 2, {}, [], "monotonic"]) {
		assert.throws(() => parseMonotonic(bad), `expected ${JSON.stringify(bad)} to be rejected`);
	}
});

test("the serialized counter says whether it can go backwards", () => {
	const row = {
		id: "cnt_1",
		user_id: "usr_1",
		name: "invoice-2026",
		value: 42,
		label: null,
		public_id: "pub_1",
		monotonic: 1,
		created_at: 0,
		updated_at: 0,
	};
	assert.equal(serializeCounter(row, "https://count.example").monotonic, true);
	assert.equal(serializeCounter({ ...row, monotonic: 0 }, "https://count.example").monotonic, false);
});
