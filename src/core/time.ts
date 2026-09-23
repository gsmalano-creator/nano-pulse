/** Everything in the database is unix epoch seconds (UTC). */
export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function toIso(seconds: number | null | undefined): string | null {
	if (seconds === null || seconds === undefined) return null;
	return new Date(seconds * 1000).toISOString();
}
