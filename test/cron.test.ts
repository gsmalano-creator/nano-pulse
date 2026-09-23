import assert from "node:assert/strict";
import { test } from "node:test";
import { CronError, nextRunFor, parseCron } from "../src/relay/cron.ts";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (epoch: number | null) =>
	epoch === null ? null : new Date(epoch * 1000).toISOString().replace(".000Z", "Z");

test("every 15 minutes in UTC", () => {
	assert.equal(iso(nextRunFor("*/15 * * * *", "UTC", at("2026-09-22T10:01:00Z"))), "2026-09-22T10:15:00Z");
	assert.equal(iso(nextRunFor("*/15 * * * *", "UTC", at("2026-09-22T10:15:00Z"))), "2026-09-22T10:30:00Z");
	assert.equal(iso(nextRunFor("*/15 * * * *", "UTC", at("2026-09-22T23:50:00Z"))), "2026-09-23T00:00:00Z");
});

test("daily at a fixed hour is offset by the zone", () => {
	assert.equal(iso(nextRunFor("0 3 * * *", "UTC", at("2026-09-22T10:00:00Z"))), "2026-09-23T03:00:00Z");
	// Oslo is UTC+2 in September, so 03:00 local is 01:00Z.
	assert.equal(iso(nextRunFor("0 3 * * *", "Europe/Oslo", at("2026-09-22T10:00:00Z"))), "2026-09-23T01:00:00Z");
});

test("the instant moves when DST ends but the wall time does not", () => {
	// 2026-10-25: Oslo goes CEST (+2) -> CET (+1) at 01:00Z.
	assert.equal(iso(nextRunFor("0 3 * * *", "Europe/Oslo", at("2026-10-23T12:00:00Z"))), "2026-10-24T01:00:00Z");
	assert.equal(iso(nextRunFor("0 3 * * *", "Europe/Oslo", at("2026-10-24T12:00:00Z"))), "2026-10-25T02:00:00Z");
	assert.equal(iso(nextRunFor("0 3 * * *", "Europe/Oslo", at("2026-10-25T12:00:00Z"))), "2026-10-26T02:00:00Z");
});

test("an ambiguous wall time fires on its first instant", () => {
	// 02:30 exists twice on 2026-10-25: 00:30Z (CEST) and 01:30Z (CET).
	assert.equal(iso(nextRunFor("30 2 * * *", "Europe/Oslo", at("2026-10-24T12:00:00Z"))), "2026-10-25T00:30:00Z");
});

test("a nonexistent wall time fires just after the gap instead of being skipped", () => {
	// 2027-03-28: Oslo goes CET (+1) -> CEST (+2) at 01:00Z, so 02:30 local
	// does not exist. It must still run that day.
	assert.equal(iso(nextRunFor("30 2 * * *", "Europe/Oslo", at("2027-03-27T12:00:00Z"))), "2027-03-28T01:30:00Z");
	// The day before and after are ordinary.
	assert.equal(iso(nextRunFor("30 2 * * *", "Europe/Oslo", at("2027-03-26T12:00:00Z"))), "2027-03-27T01:30:00Z");
	assert.equal(iso(nextRunFor("30 2 * * *", "Europe/Oslo", at("2027-03-28T12:00:00Z"))), "2027-03-29T00:30:00Z");
});

test("day-of-month and day-of-week are OR'd when both are restricted", () => {
	// The 13th or any Friday.
	assert.equal(iso(nextRunFor("0 0 13 * 5", "UTC", at("2026-09-22T00:00:00Z"))), "2026-09-25T00:00:00Z");
	assert.equal(iso(nextRunFor("0 0 13 * 5", "UTC", at("2026-10-09T12:00:00Z"))), "2026-10-13T00:00:00Z");
	// Only day-of-week restricted: every Monday.
	assert.equal(iso(nextRunFor("0 0 * * mon", "UTC", at("2026-09-22T00:00:00Z"))), "2026-09-28T00:00:00Z");
	// Sunday as 0 and as 7 mean the same thing.
	assert.equal(
		nextRunFor("0 0 * * 0", "UTC", at("2026-09-22T00:00:00Z")),
		nextRunFor("0 0 * * 7", "UTC", at("2026-09-22T00:00:00Z")),
	);
});

test("rare calendar dates are found, impossible ones are not", () => {
	assert.equal(iso(nextRunFor("0 0 29 2 *", "UTC", at("2026-09-22T00:00:00Z"))), "2028-02-29T00:00:00Z");
	assert.equal(nextRunFor("0 0 30 2 *", "UTC", at("2026-09-22T00:00:00Z")), null);
});

test("month names and lists parse", () => {
	assert.equal(iso(nextRunFor("0 12 1 jan,jul *", "UTC", at("2026-09-22T00:00:00Z"))), "2027-01-01T12:00:00Z");
	assert.equal(iso(nextRunFor("0 8-10 * * *", "UTC", at("2026-09-22T10:30:00Z"))), "2026-09-23T08:00:00Z");
});

test("the result is always strictly in the future", () => {
	const now = at("2026-09-22T10:00:00Z");
	const next = nextRunFor("* * * * *", "UTC", now);
	assert.ok(next !== null && next > now);
	assert.equal(iso(next), "2026-09-22T10:01:00Z");
});

test("invalid expressions are rejected", () => {
	for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "5-1 * * * *", "x * * * *"]) {
		assert.throws(() => parseCron(bad), CronError, `expected '${bad}' to be rejected`);
	}
});
