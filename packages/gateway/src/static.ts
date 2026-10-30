import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { apiError } from "./http.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serves the built SPA. Hashed `/assets/*` files are immutable; every other path that is not a file falls
 * back to `index.html` (client-side routing), which is never cached so deploys take effect on reload.
 */
export async function serveStatic(webDir: string, pathname: string, method: string): Promise<Response> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return apiError(400, "bad_request", "Malformed URL");
	}
	const relative = posix.normalize(decoded).replace(/^(\.\.(\/|$))+/, "");
	if (relative.includes("\0")) return apiError(400, "bad_request", "Malformed URL");
	const assets = relative.startsWith("/assets/");
	if (relative !== "/" && !relative.endsWith("/")) {
		const path = join(webDir, relative);
		if (await isFile(path)) {
			return fileResponse(path, method, assets ? IMMUTABLE : "no-cache");
		}
	}
	if (assets) return apiError(404, "not_found", `${pathname} not found`);
	const index = join(webDir, "index.html");
	if (!(await isFile(index))) {
		return apiError(503, "web_missing", `The web UI is not built (no ${index}); run pnpm --filter @romp/web build`);
	}
	return fileResponse(index, method, "no-cache");
}

function fileResponse(path: string, method: string, cacheControl: string): Response {
	const file = Bun.file(path);
	return new Response(method === "HEAD" ? null : file, {
		headers: { "content-type": file.type, "cache-control": cacheControl, "x-content-type-options": "nosniff" },
	});
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
