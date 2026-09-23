import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { renderBadge } from "../badge";
import type { AppEnv, CounterRow } from "../../types";

const badge = new Hono<AppEnv>();

/**
 * Public on purpose: a README badge is fetched anonymously through GitHub's
 * image proxy, which cannot send an Authorization header. The public id is
 * unguessable and scoped to one counter, so nothing else is exposed.
 *
 * Reads never increment. A proxy that caches — and GitHub's does, hard — would
 * make an incrementing badge both wrong and a way to hammer the database.
 *
 * One route handles both extensions: a param cannot carry a suffix in the
 * pattern without losing its type.
 */
badge.get("/:file", async (c) => {
	const file = c.req.param("file");
	const dot = file.lastIndexOf(".");
	const publicId = dot === -1 ? file : file.slice(0, dot);
	const extension = dot === -1 ? "svg" : file.slice(dot + 1).toLowerCase();

	if (extension !== "svg" && extension !== "json") {
		throw new HTTPException(404, { message: "Use .svg or .json." });
	}

	const counter = await c.env.DB.prepare("SELECT * FROM counters WHERE public_id = ?")
		.bind(publicId)
		.first<CounterRow>();
	if (!counter) throw new HTTPException(404, { message: "No such counter." });

	if (extension === "json") {
		c.header("cache-control", "public, max-age=60");
		// So a static page can read it from the browser without a key.
		c.header("access-control-allow-origin", "*");
		return c.json({ name: counter.name, label: counter.label, value: counter.value });
	}

	const label = (c.req.query("label") ?? counter.label ?? counter.name).slice(0, 32);
	const svg = renderBadge(label, counter.value, c.req.query("color") ?? "green");

	c.header("content-type", "image/svg+xml; charset=utf-8");
	c.header("cache-control", "public, max-age=60, stale-while-revalidate=300");
	c.header("etag", `"${counter.value}-${label}"`);
	return c.body(svg);
});

export default badge;
