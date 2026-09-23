/**
 * Five-field cron expressions with IANA timezone support.
 *
 * The search runs in local wall-clock space (pure calendar arithmetic) and only
 * converts to an instant at the very end. That keeps the DST policy in one
 * place instead of scattered through the loop:
 *
 *   - Nonexistent local time (spring forward): runs at the equivalent instant
 *     after the gap, so 02:30 on a gap day fires at 03:30. The job runs late in
 *     wall-clock terms rather than being silently skipped, which matters when
 *     the whole product is about noticing jobs that did not run.
 *   - Ambiguous local time (fall back): runs at the first of the two instants.
 */

export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
	/** Standard cron quirk: when both are restricted, a match on either counts. */
	domRestricted: boolean;
	dowRestricted: boolean;
}

export class CronError extends Error {}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(
	raw: string,
	min: number,
	max: number,
	names: string[] = [],
): { values: Set<number>; restricted: boolean } {
	const values = new Set<number>();
	const restricted = raw !== "*";

	for (const part of raw.split(",")) {
		const [rangePart, stepPart] = part.split("/");
		if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
			throw new CronError(`Invalid step in '${part}'.`);
		}
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (step < 1) throw new CronError(`Step must be at least 1 in '${part}'.`);

		let from: number;
		let to: number;
		if (rangePart === "*") {
			from = min;
			to = max;
		} else if (rangePart.includes("-")) {
			const [a, b] = rangePart.split("-");
			from = parseValue(a, min, max, names);
			to = parseValue(b, min, max, names);
			if (to < from) throw new CronError(`Range '${rangePart}' is inverted.`);
		} else {
			from = parseValue(rangePart, min, max, names);
			to = stepPart === undefined ? from : max;
		}

		for (let v = from; v <= to; v += step) values.add(v);
	}

	if (values.size === 0) throw new CronError(`Field '${raw}' matches nothing.`);
	return { values, restricted };
}

function parseValue(token: string, min: number, max: number, names: string[]): number {
	const lower = token.trim().toLowerCase();
	const named = names.indexOf(lower);
	if (named !== -1) return named + (names === MONTH_NAMES ? 1 : 0);
	if (!/^\d+$/.test(lower)) throw new CronError(`Invalid value '${token}'.`);
	const value = Number(lower);
	// Cron accepts both 0 and 7 for Sunday.
	if (names === DAY_NAMES && value === 7) return 0;
	if (value < min || value > max) throw new CronError(`Value '${token}' is out of range ${min}-${max}.`);
	return value;
}

export function parseCron(expression: string): CronFields {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new CronError(
			"Cron expression must have five fields: minute hour day-of-month month day-of-week.",
		);
	}

	const minutes = parseField(fields[0], 0, 59);
	const hours = parseField(fields[1], 0, 23);
	const daysOfMonth = parseField(fields[2], 1, 31);
	const months = parseField(fields[3], 1, 12, MONTH_NAMES);
	const daysOfWeek = parseField(fields[4], 0, 6, DAY_NAMES);

	return {
		minutes: minutes.values,
		hours: hours.values,
		daysOfMonth: daysOfMonth.values,
		months: months.values,
		daysOfWeek: daysOfWeek.values,
		domRestricted: daysOfMonth.restricted,
		dowRestricted: daysOfWeek.restricted,
	};
}

export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

interface WallTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

function wallTimeAt(timeZone: string, epochSeconds: number): WallTime {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).formatToParts(new Date(epochSeconds * 1000));

	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
	};
}

function utcFromWallTime(wall: WallTime): number {
	return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0) / 1000;
}

/** Offset in seconds (east of UTC) in effect at the given instant. */
function offsetAt(timeZone: string, epochSeconds: number): number {
	return utcFromWallTime(wallTimeAt(timeZone, epochSeconds)) - epochSeconds;
}

function sameWallTime(a: WallTime, b: WallTime): boolean {
	return (
		a.year === b.year &&
		a.month === b.month &&
		a.day === b.day &&
		a.hour === b.hour &&
		a.minute === b.minute
	);
}

/**
 * Instant for a local wall time. Probes the offsets in effect around the naive
 * instant, which covers every real DST shift, and applies the gap/ambiguity
 * policy documented at the top of this file.
 */
export function epochForWallTime(timeZone: string, wall: WallTime): number {
	const naive = utcFromWallTime(wall);
	const probes = [-7200, -3600, 0, 3600, 7200].map((delta) => offsetAt(timeZone, naive + delta));

	const candidates = [...new Set(probes)].map((offset) => naive - offset);
	const valid = candidates.filter((epoch) => sameWallTime(wallTimeAt(timeZone, epoch), wall));

	// Ambiguous: earliest instant. Gap: latest candidate, which is the same
	// instant shifted past the missing hour.
	return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

function dayOfWeek(wall: WallTime): number {
	return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function dayMatches(fields: CronFields, wall: WallTime): boolean {
	const dom = fields.daysOfMonth.has(wall.day);
	const dow = fields.daysOfWeek.has(dayOfWeek(wall));
	if (fields.domRestricted && fields.dowRestricted) return dom || dow;
	if (fields.domRestricted) return dom;
	if (fields.dowRestricted) return dow;
	return true;
}

function addDays(wall: WallTime, days: number): WallTime {
	const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: 0,
		minute: 0,
	};
}

/** Days in the month of `wall`. */
function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MAX_STEPS = 500_000;

/**
 * Next run strictly after `afterEpochSeconds`. Returns null when the expression
 * cannot match within ~5 years (e.g. `0 0 30 2 *`).
 */
export function nextRunAt(
	fields: CronFields,
	timeZone: string,
	afterEpochSeconds: number,
): number | null {
	// Start one minute after, truncated to the minute.
	const start = Math.floor(afterEpochSeconds / 60) * 60 + 60;
	let wall = wallTimeAt(timeZone, start);
	const limitYear = wall.year + 5;

	for (let steps = 0; steps < MAX_STEPS; steps++) {
		if (wall.year > limitYear) return null;

		if (!fields.months.has(wall.month)) {
			const nextMonth = wall.month === 12 ? 1 : wall.month + 1;
			const nextYear = wall.month === 12 ? wall.year + 1 : wall.year;
			wall = { year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0 };
			continue;
		}
		if (wall.day > daysInMonth(wall.year, wall.month)) {
			// Defensive: addDays normalises, so this only guards a bad input path.
			wall =
				wall.month === 12
					? { year: wall.year + 1, month: 1, day: 1, hour: 0, minute: 0 }
					: { year: wall.year, month: wall.month + 1, day: 1, hour: 0, minute: 0 };
			continue;
		}
		if (!dayMatches(fields, wall)) {
			wall = addDays(wall, 1);
			continue;
		}
		if (!fields.hours.has(wall.hour)) {
			if (wall.hour === 23) {
				wall = addDays(wall, 1);
			} else {
				wall = { ...wall, hour: wall.hour + 1, minute: 0 };
			}
			continue;
		}
		if (!fields.minutes.has(wall.minute)) {
			if (wall.minute === 59) {
				wall = wall.hour === 23 ? addDays(wall, 1) : { ...wall, hour: wall.hour + 1, minute: 0 };
			} else {
				wall = { ...wall, minute: wall.minute + 1 };
			}
			continue;
		}

		const epoch = epochForWallTime(timeZone, wall);
		if (epoch > afterEpochSeconds) return epoch;

		// Can happen on a fall-back hour, where the first instant of an
		// ambiguous wall time is already behind us.
		wall = { ...wall, minute: wall.minute + 1 };
	}

	return null;
}

/** Convenience wrapper used by the API and the runner. */
export function nextRunFor(
	expression: string,
	timeZone: string,
	afterEpochSeconds: number,
): number | null {
	return nextRunAt(parseCron(expression), timeZone, afterEpochSeconds);
}
