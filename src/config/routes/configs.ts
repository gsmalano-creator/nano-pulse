import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { newId } from "../../core/ids";
import { assertQuota } from "../../core/limits";
import { nowSeconds, toIso } from "../../core/time";
import { parseSlug } from "../../core/validation";
import {
	documentOf,
	etagFor,
	KEPT_REVISIONS,
	mergeDocument,
	parseDocument,
	parseIfMatch,
	parseKey,
	parseNote,
	serializeConfig,
} from "../configs";
import type { AppEnv, ConfigRevisionRow, ConfigRow } from "../../types";

const configs = new Hono<AppEnv>();

async function readJson(c: Context<AppEnv>): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new HTTPException(400, { message: "Request body must be JSON." });
	}
}

async function find(c: Context<AppEnv>, name: string): Promise<ConfigRow | null> {
	return c.env.DB.prepare("SELECT * FROM configs WHERE user_id = ? AND name = ?")
		.bind(c.get("user").id, name)
		.first<ConfigRow>();
}

async function mustFind(c: Context<AppEnv>, name: string): Promise<ConfigRow> {
	const config = await find(c, name);
	if (!config) throw new HTTPException(404, { message: `No config named '${name}'.` });
	return config;
}

function versionConflict(expected: number, actual: number): never {
	throw new HTTPException(412, {
		res: Response.json(
			{
				error: {
					code: "version_conflict",
					message: `Config is at version ${actual}, not ${expected}. Re-read it and try again.`,
					expected_version: expected,
					current_version: actual,
				},
			},
			{ status: 412 },
		),
	});
}

/**
 * Writes the document as a new version and records the revision. The version
 * check and the write are one statement, so two writers racing with the same
 * If-Match cannot both succeed.
 */
async function write(
	c: Context<AppEnv>,
	config: ConfigRow,
	document: Record<string, unknown>,
	ifMatch: number | null,
	note: string | null,
): Promise<ConfigRow> {
	const now = nowSeconds();
	const updated = await c.env.DB.prepare(
		`UPDATE configs SET data = ?1, version = version + 1, updated_at = ?2
		  WHERE id = ?3 AND (?4 IS NULL OR version = ?4)
		 RETURNING *`,
	)
		.bind(JSON.stringify(document), now, config.id, ifMatch)
		.first<ConfigRow>();

	if (!updated) {
		const current = await mustFind(c, config.name);
		versionConflict(ifMatch as number, current.version);
	}

	await c.env.DB.batch([
		c.env.DB.prepare(
			"INSERT INTO config_revisions (config_id, version, data, note, created_at) VALUES (?, ?, ?, ?, ?)",
		).bind(updated.id, updated.version, updated.data, note, now),
		// Keep the tail bounded; history is a convenience, not an audit log.
		c.env.DB.prepare(
			`DELETE FROM config_revisions
			  WHERE config_id = ?1
			    AND version <= (SELECT max(version) FROM config_revisions WHERE config_id = ?1) - ?2`,
		).bind(updated.id, KEPT_REVISIONS),
	]);

	return updated;
}

configs.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM configs WHERE user_id = ? ORDER BY name ASC",
	)
		.bind(c.get("user").id)
		.all<ConfigRow>();

	return c.json({
		configs: (results ?? []).map((config) => ({
			name: config.name,
			version: config.version,
			keys: Object.keys(documentOf(config)).length,
			updated_at: toIso(config.updated_at),
		})),
	});
});

/** The hot path. ETag + If-None-Match so polling costs a 304, not a payload. */
configs.get("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const config = await mustFind(c, name);
	const etag = etagFor(config.version);

	c.header("ETag", etag);
	c.header("Cache-Control", "no-cache");

	if (c.req.header("if-none-match") === etag) {
		return c.body(null, 304);
	}
	return c.json(serializeConfig(config));
});

/** One value, for the kill-switch case where a whole document is overkill. */
configs.get("/:name/keys/:key", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const key = parseKey(c.req.param("key"));
	const config = await mustFind(c, name);
	const document = documentOf(config);

	if (!(key in document)) {
		throw new HTTPException(404, { message: `Config '${name}' has no key '${key}'.` });
	}

	c.header("ETag", etagFor(config.version));
	c.header("Cache-Control", "no-cache");
	return c.json({ name, key, value: document[key], version: config.version });
});

/** Replace the whole document, creating it if it does not exist yet. */
configs.put("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const document = parseDocument(await readJson(c));
	const ifMatch = parseIfMatch(c.req.header("if-match"));
	const note = parseNote(c.req.query("note"));

	const existing = await find(c, name);
	if (!existing) {
		if (ifMatch !== null) {
			throw new HTTPException(404, { message: `No config named '${name}' to match against.` });
		}
		await assertQuota(c.env, c.get("user"), "config");
		const now = nowSeconds();
		const id = newId("cfg");
		await c.env.DB.prepare(
			`INSERT INTO configs (id, user_id, name, data, version, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)
			 ON CONFLICT (user_id, name) DO NOTHING`,
		)
			.bind(id, c.get("user").id, name, JSON.stringify(document), now, now)
			.run();

		const created = await mustFind(c, name);
		await c.env.DB.prepare(
			"INSERT INTO config_revisions (config_id, version, data, note, created_at) VALUES (?, ?, ?, ?, ?)",
		)
			.bind(created.id, created.version, created.data, note, now)
			.run();

		c.header("ETag", etagFor(created.version));
		return c.json(serializeConfig(created), 201);
	}

	const updated = await write(c, existing, document, ifMatch, note);
	c.header("ETag", etagFor(updated.version));
	return c.json(serializeConfig(updated));
});

/** Merge keys. A null value removes the key. */
configs.patch("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const body = await readJson(c);
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HTTPException(400, { message: "A patch must be a JSON object." });
	}
	const config = await mustFind(c, name);
	const merged = parseDocument(
		mergeDocument(documentOf(config), body as Record<string, unknown>),
	);

	const updated = await write(
		c,
		config,
		merged,
		parseIfMatch(c.req.header("if-match")),
		parseNote(c.req.query("note")),
	);
	c.header("ETag", etagFor(updated.version));
	return c.json(serializeConfig(updated));
});

configs.get("/:name/revisions", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const config = await mustFind(c, name);
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM config_revisions WHERE config_id = ? ORDER BY version DESC",
	)
		.bind(config.id)
		.all<ConfigRevisionRow>();

	return c.json({
		name,
		current_version: config.version,
		revisions: (results ?? []).map((revision) => ({
			version: revision.version,
			note: revision.note,
			created_at: toIso(revision.created_at),
			data: JSON.parse(revision.data) as Record<string, unknown>,
		})),
	});
});

/**
 * Rollback writes the old content as a *new* version rather than rewinding the
 * counter, so a client caching by version never sees the same number twice with
 * different content.
 */
configs.post("/:name/rollback", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const config = await mustFind(c, name);
	const body = (await readJson(c)) as Record<string, unknown>;
	const to = Number(body?.to ?? c.req.query("to"));

	if (!Number.isInteger(to) || to < 1) {
		throw new HTTPException(400, { message: "to must be the version number to restore." });
	}

	const revision = await c.env.DB.prepare(
		"SELECT * FROM config_revisions WHERE config_id = ? AND version = ?",
	)
		.bind(config.id, to)
		.first<ConfigRevisionRow>();

	if (!revision) {
		throw new HTTPException(404, {
			message: `Version ${to} of '${name}' is no longer kept.`,
		});
	}

	const updated = await write(
		c,
		config,
		JSON.parse(revision.data) as Record<string, unknown>,
		parseIfMatch(c.req.header("if-match")),
		`rollback to v${to}`,
	);

	c.header("ETag", etagFor(updated.version));
	return c.json({ ...serializeConfig(updated), rolled_back_from: config.version, restored: to });
});

configs.delete("/:name", async (c) => {
	const name = parseSlug(c.req.param("name"));
	const config = await mustFind(c, name);

	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM config_revisions WHERE config_id = ?").bind(config.id),
		c.env.DB.prepare("DELETE FROM configs WHERE id = ?").bind(config.id),
	]);

	return c.json({ deleted: name });
});

export default configs;
