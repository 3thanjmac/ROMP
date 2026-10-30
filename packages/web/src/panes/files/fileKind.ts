/** File type guesses from names, for row icons and for opening images in a browser window. */
import type { FsEntry } from "@romp/protocol";
import { Icons, type IconComponent } from "../../lib/icons";

const flags = (names: string[]): Record<string, true> => Object.fromEntries(names.map((n) => [n, true]));

const IMAGE = flags(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"]);
const CODE = flags([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "svelte", "vue", "json", "jsonc", "css", "scss", "html", "md", "py", "rs",
	"go", "rb", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "sh", "bash", "zsh", "fish", "toml", "yaml", "yml",
	"sql", "lua", "php", "swift", "xml", "ini", "conf", "dockerfile", "makefile", "nix", "zig", "ex", "exs",
]);

export function extension(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "dockerfile" || lower === "makefile") return lower;
	const i = lower.lastIndexOf(".");
	return i > 0 ? lower.slice(i + 1) : "";
}

export function isImage(name: string): boolean {
	return IMAGE[extension(name)] === true;
}

export function entryIcon(entry: Pick<FsEntry, "name" | "kind">): IconComponent {
	if (entry.kind === "dir") return Icons.Folder;
	if (isImage(entry.name)) return Icons.FileImage;
	if (CODE[extension(entry.name)]) return Icons.FileCode;
	return Icons.File;
}

/** Valid single path segment for create/rename. */
export function validName(name: string): boolean {
	const n = name.trim();
	return n.length > 0 && !n.includes("/") && n !== "." && n !== "..";
}
