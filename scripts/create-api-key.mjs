#!/usr/bin/env node
// Mints an API key and prints the SQL needed to install it.
// There is no signup endpoint yet, so keys are provisioned by hand:
//   node scripts/create-api-key.mjs you@example.com "Laptop key"
//   ... then pipe the SQL into: npx wrangler d1 execute DB --local --command "<sql>"
import { createHash, randomBytes } from "node:crypto";

const [email, name = "API key", environment = "live"] = process.argv.slice(2);

if (!email) {
	console.error("usage: node scripts/create-api-key.mjs <email> [key-name] [live|test]");
	process.exit(1);
}

const key = `np_${environment}_${randomBytes(20).toString("hex")}`;
const hash = createHash("sha256").update(key).digest("hex");
const userId = `usr_${randomBytes(16).toString("hex")}`;
const keyId = `key_${randomBytes(16).toString("hex")}`;
const escape = (value) => value.replaceAll("'", "''");

console.log(`API key (store it now, it is not recoverable):\n\n  ${key}\n`);
console.log("SQL:\n");
console.log(
	`INSERT INTO users (id, email) VALUES ('${userId}', '${escape(email)}') ON CONFLICT (email) DO NOTHING;`,
);
console.log(
	`INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash) SELECT '${keyId}', id, '${escape(name)}', '${key.slice(0, 12)}', '${hash}' FROM users WHERE email = '${escape(email)}';`,
);
