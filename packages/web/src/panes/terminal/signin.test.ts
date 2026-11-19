import { describe, expect, it } from "vitest";
import { findSignInPrompt, tailText } from "./signin";

const WRANGLER =
	"https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594-84e4-41aa-b438-e81b8fa78ee7" +
	"&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread%20user%3Aread%20workers%3Awrite" +
	"%20offline_access&state=Kq3dZ1&code_challenge=Vb8w_x&code_challenge_method=S256";
const CODEX =
	"https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann" +
	"&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access" +
	"&code_challenge=Qm9u&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true" +
	"&state=f00d&originator=codex_cli_rs";
const GOOGLE =
	"https://accounts.google.com/o/oauth2/auth?client_id=563584335869.apps.googleusercontent.com" +
	"&scope=email%20openid&response_type=code&state=812&redirect_uri=http://localhost:9005";

/** Rows as xterm holds them: `wrapped` marks a soft-wrap continuation; untrimmed text is padded to `cols`. */
function buffer(rows: Array<{ text: string; wrapped?: boolean }>, cols: number) {
	return {
		length: rows.length,
		getLine: (i: number) => {
			const row = rows[i];
			if (!row) return undefined;
			return {
				isWrapped: !!row.wrapped,
				translateToString: (trimRight?: boolean) => (trimRight ? row.text.trimEnd() : row.text.padEnd(cols)),
			} as never;
		},
	};
}

/** Splits `line` into rows of `cols`, the later ones marked as soft-wrapped. */
function wrap(line: string, cols: number, wrapped = true): Array<{ text: string; wrapped?: boolean }> {
	const rows = [];
	for (let i = 0; i < line.length; i += cols) rows.push({ text: line.slice(i, i + cols), wrapped: i > 0 && wrapped });
	return rows;
}

describe("findSignInPrompt", () => {
	it("finds wrangler's percent-encoded redirect", () => {
		const out = `Attempting to login via OAuth...\nOpening a link in your default browser: ${WRANGLER}\n`;
		expect(findSignInPrompt(out)).toEqual({ authUrl: WRANGLER, port: 8976, path: "/oauth/callback" });
	});

	it("finds Codex's redirect", () => {
		const out = `Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${CODEX}\n`;
		expect(findSignInPrompt(out)).toEqual({ authUrl: CODEX, port: 1455, path: "/auth/callback" });
	});

	it("finds an unencoded redirect", () => {
		expect(findSignInPrompt(`Visit this URL on this device to log in:\n${GOOGLE}\n`)).toEqual({
			authUrl: GOOGLE,
			port: 9005,
			path: "/",
		});
	});

	it("finds a doubly encoded redirect and drops trailing punctuation", () => {
		const url = "https://example.com/authorize?redirect_uri=http%253A%252F%252F127.0.0.1%253A53682%252Fcb&state=1";
		expect(findSignInPrompt(`Open (${url}).`)).toEqual({ authUrl: url, port: 53682, path: "/cb" });
	});

	it("reports the last prompt when several were printed", () => {
		expect(findSignInPrompt(`${WRANGLER}\n${CODEX}`)?.port).toBe(1455);
	});

	it("stops at a TUI border", () => {
		expect(findSignInPrompt(`│ ${CODEX} │`)?.authUrl).toBe(CODEX);
	});

	it("ignores URLs that don't redirect to a loopback port", () => {
		for (const text of [
			"Starting local login server on http://localhost:1455.",
			"https://github.com/login/device",
			"https://example.com/auth?redirect_uri=https%3A%2F%2Fexample.com%2Fcb",
			"https://example.com/auth?redirect_uri=https%3A%2F%2Flocalhost%3A8976%2Fcb",
			"https://example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%2Fcb",
			"https://example.com/auth?redirect_uri=http%3A%2F%2F10.0.0.2%3A8976%2Fcb",
		]) {
			expect(findSignInPrompt(text)).toBeNull();
		}
	});
});

describe("tailText", () => {
	const cols = 80;

	it("joins soft-wrapped rows so a long URL reads whole", () => {
		const rows = [{ text: "Opening a link in your default browser:" }, ...wrap(WRANGLER, cols), { text: "$" }];
		const text = tailText(buffer(rows, cols), cols, 100);
		expect(text).toBe(`Opening a link in your default browser:\n${WRANGLER}\n$`);
		expect(findSignInPrompt(text)?.port).toBe(8976);
	});

	it("joins full-width rows a TUI printed on separate lines", () => {
		const rows = [{ text: "Sign in:" }, ...wrap(CODEX, cols, false), { text: "" }, { text: "Press Esc to cancel" }];
		expect(findSignInPrompt(tailText(buffer(rows, cols), cols, 100))).toMatchObject({ authUrl: CODEX, port: 1455 });
	});

	it("starts at the beginning of the logical line the window cuts into", () => {
		const rows = [{ text: "before" }, ...wrap(CODEX, cols), { text: "after" }];
		const text = tailText(buffer(rows, cols), cols, 3);
		expect(text).toBe(`${CODEX}\nafter`);
	});

	it("keeps short rows apart", () => {
		const rows = [{ text: "one" }, { text: "two" }];
		expect(tailText(buffer(rows, cols), cols, 10)).toBe("one\ntwo");
	});
});
