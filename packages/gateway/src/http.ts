import { RompError } from "@romp/core";
import type { ApiError } from "@romp/protocol";
import { errnoCode, errorMessage, isRecord } from "./util.ts";

/** An error that maps onto an `ApiError` response. `extra` fields are merged into the body. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly extra?: Record<string, unknown>,
	) {
		super(message);
	}
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const forbidden = (message: string) => new HttpError(403, "forbidden", message);
export const notFound = (message: string) => new HttpError(404, "not_found", message);
export const conflict = (message: string, extra?: Record<string, unknown>) =>
	new HttpError(409, "conflict", message, extra);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function noContent(): Response {
	return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export function apiError(status: number, error: string, message: string, extra?: Record<string, unknown>): Response {
	const body: ApiError & Record<string, unknown> = { ...extra, error, message };
	return json(body, status);
}

const ROMP_STATUS: Record<RompError["code"], number> = {
	not_found: 404,
	conflict: 409,
	bad_request: 400,
	forbidden: 403,
	git_failed: 500,
};

const FS_ERRORS: Record<string, [status: number, error: string, text: string]> = {
	ENOENT: [404, "not_found", "No such file or directory"],
	EEXIST: [409, "conflict", "Already exists"],
	ENOTEMPTY: [409, "conflict", "Directory not empty"],
	EBUSY: [409, "conflict", "Resource busy"],
	EACCES: [403, "forbidden", "Permission denied"],
	EPERM: [403, "forbidden", "Operation not permitted"],
	EROFS: [403, "forbidden", "Read-only file system"],
	ENOTDIR: [400, "bad_request", "Not a directory"],
	EISDIR: [400, "bad_request", "Is a directory"],
	EINVAL: [400, "bad_request", "Invalid argument"],
	ENAMETOOLONG: [400, "bad_request", "File name too long"],
	ELOOP: [400, "bad_request", "Too many levels of symbolic links"],
	ENOSPC: [507, "no_space", "No space left on device"],
};

export function toErrorResponse(err: unknown): Response {
	if (err instanceof HttpError) return apiError(err.status, err.code, err.message, err.extra);
	if (err instanceof RompError) return apiError(ROMP_STATUS[err.code] ?? 500, err.code, err.message);
	const fs = FS_ERRORS[errnoCode(err) ?? ""];
	if (fs) {
		const path = typeof err === "object" && err !== null && "path" in err ? err.path : undefined;
		return apiError(fs[0], fs[1], typeof path === "string" ? `${fs[2]}: ${path}` : fs[2]);
	}
	console.error("request failed:", err);
	return apiError(500, "internal", errorMessage(err));
}

/**
 * Reads a JSON request body of at most `limit` bytes. An empty body yields `{}`. A non-empty body must be
 * `application/json`, which a cross-site form or `no-cors` fetch cannot send without a CORS preflight.
 */
export async function readJson(req: Request, limit: number): Promise<Record<string, unknown>> {
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > limit) throw tooLarge(limit);
	const buf = await req.arrayBuffer();
	if (buf.byteLength === 0) return {};
	if (buf.byteLength > limit) throw tooLarge(limit);
	if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
		throw new HttpError(415, "unsupported_media_type", "Request bodies must be application/json");
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(buf));
	} catch {
		throw badRequest("Request body is not valid JSON");
	}
	if (!isRecord(value)) throw badRequest("Request body must be a JSON object");
	return value;
}

function tooLarge(limit: number): HttpError {
	return new HttpError(413, "too_large", `Request body exceeds ${Math.round(limit / 1024)} KiB`);
}

export function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value === "") throw badRequest(`"${key}" must be a non-empty string`);
	return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw badRequest(`"${key}" must be a string`);
	return value;
}

export function requireInt(body: Record<string, unknown>, key: string, min: number, max: number): number {
	const value = body[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw badRequest(`"${key}" must be an integer between ${min} and ${max}`);
	}
	return value;
}
