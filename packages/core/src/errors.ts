export type RompErrorCode = "not_found" | "conflict" | "bad_request" | "forbidden" | "git_failed";

/** Error with a stable code; the gateway maps it to HTTP 404/409/400/403/500. */
export class RompError extends Error {
	readonly code: RompErrorCode;

	constructor(code: RompErrorCode, message: string) {
		super(message);
		this.name = "RompError";
		this.code = code;
	}
}
