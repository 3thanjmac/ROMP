/** Typed client for the gateway HTTP API (see @romp/protocol for the routes). */
import type {
	AgentCreate,
	AgentInfo,
	ApiError,
	FsFile,
	FsList,
	FsOpRequest,
	FsOpResult,
	FsWriteRequest,
	FsWriteResult,
	ListeningPort,
	LoginRequest,
	Me,
	RepoAdd,
	RepoInfo,
	RepoSettingsUpdate,
	ShellState,
	TaskCreate,
	TaskCreated,
	TaskInfo,
	TaskShip,
	TermCreate,
	TermInfo,
} from "@romp/protocol";
import { net } from "./conn/net.svelte";
import { signIn } from "./conn/signin.svelte";

/** A failed request. `status` 0 means the gateway could not be reached. `message` is ApiError.message. */
export class ApiFailure extends Error {
	readonly status: number;
	readonly body: ApiError & Record<string, unknown>;

	constructor(status: number, body: ApiError & Record<string, unknown>) {
		super(body.message);
		this.name = "ApiFailure";
		this.status = status;
		this.body = body;
	}

	get code(): string {
		return this.body.error;
	}
}

const UNREACHABLE: ApiError & Record<string, unknown> = {
	error: "unreachable",
	message: "Can't reach the gateway. Check your connection and try again.",
};

/** Turns anything thrown by a request into a message safe to show the user. */
export function errorMessage(err: unknown): string {
	if (err instanceof ApiFailure) return err.message;
	if (err instanceof Error && err.message) return err.message;
	return "The request failed.";
}

function isApiError(value: unknown): value is ApiError & Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ApiError).error === "string" &&
		typeof (value as ApiError).message === "string"
	);
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			cache: "no-store",
			signal,
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		net.reportDown();
		throw new ApiFailure(0, UNREACHABLE);
	}
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		parsed = undefined;
	}
	if (res.ok) {
		net.reportUp();
		return parsed as T;
	}
	if (isApiError(parsed)) {
		net.reportUp();
		if (res.status === 401 && parsed.error === "login_required") signIn.required = true;
		throw new ApiFailure(res.status, parsed);
	}
	// A non-JSON 5xx comes from a proxy in front of a gateway that is down (tailscale serve, or Vite in dev).
	if (res.status >= 500) {
		net.reportDown();
		throw new ApiFailure(0, UNREACHABLE);
	}
	throw new ApiFailure(res.status, {
		error: `http_${res.status}`,
		message: `The gateway answered ${res.status} ${res.statusText}.`.replace(" .", "."),
	});
}

const q = encodeURIComponent;

export const api = {
	me: () => request<Me>("GET", "/api/me"),
	/** LAN sign-in; the gateway answers with the session cookie. */
	login: (req: LoginRequest) => request<undefined>("POST", "/api/login", req),

	state: {
		/** null when nothing has been saved yet (404). */
		async get(): Promise<ShellState | null> {
			try {
				return await request<ShellState>("GET", "/api/state");
			} catch (err) {
				if (err instanceof ApiFailure && err.status === 404) return null;
				throw err;
			}
		},
		put: (state: ShellState) => request<unknown>("PUT", "/api/state", state),
	},

	fs: {
		list: (path: string, signal?: AbortSignal) => request<FsList>("GET", `/api/fs/list?path=${q(path)}`, undefined, signal),
		read: (path: string, signal?: AbortSignal) => request<FsFile>("GET", `/api/fs/read?path=${q(path)}`, undefined, signal),
		write: (req: FsWriteRequest) => request<FsWriteResult>("PUT", "/api/fs/write", req),
		op: (req: FsOpRequest) => request<FsOpResult>("POST", "/api/fs/op", req),
		rawUrl: (path: string) => `/api/fs/raw?path=${q(path)}`,
	},

	terms: {
		list: () => request<TermInfo[]>("GET", "/api/terms"),
		create: (req: TermCreate) => request<TermInfo>("POST", "/api/terms", req),
		kill: (id: string) => request<unknown>("DELETE", `/api/terms/${q(id)}`),
	},

	agents: {
		list: () => request<AgentInfo[]>("GET", "/api/agents"),
		create: (req: AgentCreate) => request<AgentInfo>("POST", "/api/agents", req),
		kill: (id: string) => request<unknown>("DELETE", `/api/agents/${q(id)}`),
	},

	repos: {
		list: () => request<RepoInfo[]>("GET", "/api/repos"),
		add: (req: RepoAdd) => request<RepoInfo>("POST", "/api/repos", req),
		settings: (name: string, patch: RepoSettingsUpdate) =>
			request<RepoInfo>("PUT", `/api/repos/${q(name)}/settings`, patch),
	},

	tasks: {
		list: () => request<TaskInfo[]>("GET", "/api/tasks"),
		create: (req: TaskCreate) => request<TaskCreated>("POST", "/api/tasks", req),
		ship: (repo: string, slug: string, req: TaskShip = {}) =>
			request<TaskInfo>("POST", `/api/tasks/${q(repo)}/${q(slug)}/ship`, req),
		remove: (repo: string, slug: string) => request<unknown>("DELETE", `/api/tasks/${q(repo)}/${q(slug)}`),
	},

	ports: {
		list: () => request<ListeningPort[]>("GET", "/api/ports"),
	},
};
