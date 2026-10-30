/**
 * Assistant markdown (marked + DOMPurify), split into top-level blocks so a streaming message only re-renders its
 * last block and code blocks can render as components with a copy button.
 */
import createPurify, { type DOMPurify } from "dompurify";
import { Marked, type Token, type TokensList } from "marked";

export type MdBlock = { kind: "html"; html: string } | { kind: "code"; lang: string; text: string };

const md = new Marked({ gfm: true });
const CACHE_LIMIT = 1500;
/** Sanitized HTML by block source, shared by every message (completed blocks never change). */
const cache = new Map<string, string>();
let purify: DOMPurify | null = null;

function sanitizer(): DOMPurify {
	if (purify) return purify;
	purify = createPurify(window);
	purify.addHook("afterSanitizeAttributes", node => {
		if (node.tagName === "A" && node.hasAttribute("href")) {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer");
		}
	});
	return purify;
}

function render(token: Token, links: TokensList["links"], cacheable: boolean): string {
	const hit = cache.get(token.raw);
	if (hit !== undefined) return hit;
	const html = sanitizer().sanitize(md.parser(Object.assign([token], { links })));
	if (cacheable) {
		if (cache.size >= CACHE_LIMIT) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		cache.set(token.raw, html);
	}
	return html;
}

/** `streaming` keeps the still-growing last block out of the cache. */
export function markdownBlocks(text: string, streaming: boolean): MdBlock[] {
	const tokens = md.lexer(text);
	const growing = streaming ? tokens.findLastIndex(t => t.type !== "space") : -1;
	const blocks: MdBlock[] = [];
	tokens.forEach((token, i) => {
		if (token.type === "space") return;
		if (token.type === "code") {
			blocks.push({ kind: "code", lang: typeof token.lang === "string" ? token.lang : "", text: String(token.text) });
			return;
		}
		blocks.push({ kind: "html", html: render(token, tokens.links, i !== growing) });
	});
	return blocks;
}
