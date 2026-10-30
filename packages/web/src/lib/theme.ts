/**
 * Resolves design tokens to rgba() strings for libraries that cannot parse oklch() or var() (xterm). Each token
 * is painted into a 1×1 canvas and read back, so relative-color tokens resolve exactly as the browser draws them.
 */
import type { ITheme } from "@xterm/xterm";

let ctx: CanvasRenderingContext2D | null = null;
let probe: HTMLElement | null = null;

function context(): CanvasRenderingContext2D {
	if (ctx) return ctx;
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const c = canvas.getContext("2d", { willReadFrequently: true });
	if (!c) throw new Error("2D canvas is unavailable");
	ctx = c;
	return c;
}

/** The computed color of `var(--token)` as an rgba() string. */
export function tokenColor(token: string): string {
	if (!probe) {
		probe = document.createElement("span");
		probe.style.display = "none";
		document.body.append(probe);
	}
	probe.style.color = `var(--${token})`;
	const computed = getComputedStyle(probe).color;
	const c = context();
	c.clearRect(0, 0, 1, 1);
	c.fillStyle = "#000";
	c.fillStyle = computed;
	c.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
	return `rgba(${r}, ${g}, ${b}, ${Math.round(((a ?? 255) / 255) * 1000) / 1000})`;
}

/** A numeric token in px (e.g. --term-font-size). */
export function tokenPx(token: string): number {
	const v = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`);
	return Number.parseFloat(v) || 13;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

export function terminalTheme(): ITheme {
	const theme: Record<string, string> = {
		background: tokenColor("surface-1"),
		foreground: tokenColor("fg"),
		cursor: tokenColor("accent"),
		cursorAccent: tokenColor("surface-1"),
		selectionBackground: tokenColor("accent-soft"),
	};
	for (const name of ANSI) {
		theme[name] = tokenColor(`ansi-${name}`);
		theme[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = tokenColor(`ansi-bright-${name}`);
	}
	return theme as ITheme;
}
