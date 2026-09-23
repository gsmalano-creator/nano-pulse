import { formatValue } from "./counters";

/**
 * An SVG badge, drawn here rather than fetched from anywhere: two rounded
 * segments, monospace, no gradients. Text width is estimated from the
 * character count because the renderer has no font metrics — monospace makes
 * that estimate honest.
 */
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const CHAR_WIDTH = 6.6;
const PADDING = 9;
const HEIGHT = 20;

const COLOURS: Record<string, string> = {
	green: "#35d399",
	blue: "#7cc9f0",
	amber: "#fbbf5c",
	red: "#fb7185",
	grey: "#9bacc0",
};

function escapeXml(value: string): string {
	return value.replace(/[<>&"']/g, (c) =>
		({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string,
	);
}

export function renderBadge(rawLabel: string, value: number, colourName: string): string {
	const label = escapeXml(rawLabel.slice(0, 32));
	const text = escapeXml(formatValue(value));
	const colour = COLOURS[colourName] ?? COLOURS.green;

	const labelWidth = Math.round(label.length * CHAR_WIDTH + PADDING * 2);
	const valueWidth = Math.round(text.length * CHAR_WIDTH + PADDING * 2);
	const width = labelWidth + valueWidth;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="${label}: ${text}">
  <title>${label}: ${text}</title>
  <rect width="${width}" height="${HEIGHT}" rx="4" fill="#1b2430"/>
  <path d="M${labelWidth} 0 H${width - 4} a4 4 0 0 1 4 4 v12 a4 4 0 0 1 -4 4 H${labelWidth} z" fill="${colour}"/>
  <g font-family="${FONT}" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#c8d4e0" text-anchor="middle">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#08131a" text-anchor="middle" font-weight="600">${text}</text>
  </g>
</svg>`;
}
