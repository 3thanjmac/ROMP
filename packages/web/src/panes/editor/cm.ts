/** CodeMirror 6 setup for the editor pane: token-driven theme and language loading by file name. */
import { type Extension } from "@codemirror/state";
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basename } from "../../lib/format";

/** Theme from tokens; CodeMirror accepts var() since it only writes CSS. */
export const tokenTheme: Extension = EditorView.theme({
	"&": {
		height: "100%",
		color: "var(--fg)",
		backgroundColor: "var(--surface-1)",
		fontSize: "var(--text-sm)",
	},
	".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
	".cm-content": { caretColor: "var(--accent)" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
	"&.cm-focused": { outline: "none" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
		{ backgroundColor: "var(--accent-soft)" },
	".cm-gutters": {
		backgroundColor: "var(--surface-1)",
		color: "var(--fg-subtle)",
		border: "none",
	},
	".cm-activeLine": { backgroundColor: "var(--active-line)" },
	".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--fg-muted)" },
	".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--fg)" },
	".cm-panels.cm-panels-top": { borderBottom: "var(--border)" },
	".cm-searchMatch": { backgroundColor: "var(--warning-soft)" },
	".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
	".cm-tooltip": {
		backgroundColor: "var(--surface-2)",
		border: "var(--border)",
		borderRadius: "var(--radius-md)",
		boxShadow: "var(--shadow-md)",
	},
	".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--surface-3)", color: "var(--fg)" },
	".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "none", color: "var(--fg-muted)" },
	".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
});

/** Syntax colors readable on the current scheme's --surface-1. */
export function highlightFor(dark: boolean): Extension {
	return syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle);
}

/** The language support for `path`, or null when none matches. */
export async function languageFor(path: string): Promise<Extension | null> {
	const desc = LanguageDescription.matchFilename(languages, basename(path));
	if (!desc) return null;
	return desc.support ?? (await desc.load());
}
