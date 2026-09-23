import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeTargetShape, UnsafeTargetError } from "../src/relay/url-guard.ts";

const rejected = [
	"http://example.com/hook", // not https
	"https://user:pass@example.com/hook", // credentials
	"https://localhost/hook",
	"https://something.localhost/hook",
	"https://db.internal/hook",
	"https://printer.local/hook",
	"https://metadata.google.internal/computeMetadata/v1/",
	"https://169.254.169.254/latest/meta-data/", // cloud metadata
	"https://127.0.0.1/hook",
	"https://10.0.0.5/hook",
	"https://172.16.3.4/hook",
	"https://192.168.1.1/hook",
	"https://100.64.0.1/hook", // carrier-grade NAT
	"https://[::1]/hook",
	"https://[fd00::1]/hook",
	"not-a-url",
];

test("private and malformed targets are refused", () => {
	for (const url of rejected) {
		assert.throws(
			() => assertSafeTargetShape(url, false),
			UnsafeTargetError,
			`expected '${url}' to be refused`,
		);
	}
});

test("ordinary public targets are accepted", () => {
	for (const url of [
		"https://api.example.com/jobs/nightly",
		"https://example.com:8443/hook?token=abc",
		"https://8.8.8.8/hook",
	]) {
		assert.doesNotThrow(() => assertSafeTargetShape(url, false), `expected '${url}' to pass`);
	}
});

test("the dev escape hatch bypasses the checks", () => {
	assert.doesNotThrow(() => assertSafeTargetShape("http://127.0.0.1:9999/job", true));
});
