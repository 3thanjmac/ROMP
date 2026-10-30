/**
 * Wire contract between the ROMP gateway (Bun, runs on the VM) and the web shell (Svelte SPA).
 *
 * Transport rules:
 * - HTTP JSON under `/api/*`. Errors are `ApiError` bodies with a non-2xx status.
 * - One WebSocket per live resource: `/ws/term/:id`, `/ws/agent/:id`. Messages are JSON text frames.
 * - Dev-server proxy: `/proxy/:port/*` strips the prefix; `/absproxy/:port/*` forwards the full path
 *   (for apps configured with a matching base path, e.g. `vite --base /absproxy/5173/`). Both upgrade WebSockets.
 * - Static SPA is served from `/` with history fallback to `index.html`.
 */

// ───────────────────────────── Common ─────────────────────────────

export interface ApiError {
	/** Stable machine code, e.g. `not_found`, `conflict`, `forbidden`, `bad_request`, `git_failed`. */
	error: string;
	/** Human-readable explanation, safe to show in a toast. */
	message: string;
}

/** `GET /api/me` */
export interface Me {
	/** Tailscale login (`Tailscale-User-Login` header) or `dev` when auth is disabled. */
	login: string;
	/** Tailscale display name, falls back to `login`. */
	displayName: string;
	/** Tailscale profile picture URL when available. */
	avatarUrl: string | null;
	/** Linux account the gateway runs as. */
	user: string;
	/** VM hostname. */
	host: string;
	/** Absolute home directory of `user`. */
	home: string;
	/** Absolute directories the file API may touch (realpath-confined). */
	roots: string[];
}

// ───────────────────────────── Shell layout ─────────────────────────────

export type WindowKind = "terminal" | "files" | "editor" | "agent" | "browser" | "tasks";

export interface TerminalProps {
	/** Gateway terminal session id; absent until the session is created. */
	termId?: string;
	cwd?: string;
}
export interface FilesProps {
	path: string;
}
export interface EditorProps {
	path: string;
}
export interface AgentProps {
	agentId?: string;
	cwd: string;
}
export interface BrowserProps {
	/** Either a proxied local port path (`/proxy/5173/`) or an absolute URL (e.g. a Selkies desktop). */
	url: string;
}
export interface TasksProps {
	repo?: string;
}

export type WindowState =
	| { id: string; kind: "terminal"; title: string; width: number; props: TerminalProps }
	| { id: string; kind: "files"; title: string; width: number; props: FilesProps }
	| { id: string; kind: "editor"; title: string; width: number; props: EditorProps }
	| { id: string; kind: "agent"; title: string; width: number; props: AgentProps }
	| { id: string; kind: "browser"; title: string; width: number; props: BrowserProps }
	| { id: string; kind: "tasks"; title: string; width: number; props: TasksProps };

/** Binary split tree for tiling mode. Leaves reference `WindowState.id`. */
export type TileNode =
	| { type: "leaf"; windowId: string }
	| { type: "split"; dir: "row" | "column"; ratio: number; a: TileNode; b: TileNode };

export interface Workspace {
	id: string;
	name: string;
	/** `scroll` = niri-style horizontal strip of columns; `tile` = dwindle split tree. Same windows in both. */
	mode: "scroll" | "tile";
	/** Window order = strip order in scroll mode, insertion order for tiling. `width` is the column fraction (0.25–1). */
	windows: WindowState[];
	focusedId: string | null;
	/** Present once the workspace has been tiled at least once; rebuilt when windows are added/removed. */
	tile: TileNode | null;
}

/** `GET /api/state`, `PUT /api/state`. Opaque to the gateway apart from size limit (1 MiB) and `version`. */
export interface ShellState {
	version: 1;
	activeWorkspaceId: string;
	workspaces: Workspace[];
}

// ───────────────────────────── Files ─────────────────────────────

export interface FsEntry {
	name: string;
	/** Absolute path. */
	path: string;
	kind: "file" | "dir" | "symlink" | "other";
	size: number;
	mtimeMs: number;
}

/** `GET /api/fs/list?path=`: dirs first, then files, each alphabetical. */
export interface FsList {
	path: string;
	parent: string | null;
	entries: FsEntry[];
}

/** `GET /api/fs/read?path=`: text files up to 5 MiB; larger or binary files return `content: null`. */
export interface FsFile {
	path: string;
	content: string | null;
	binary: boolean;
	tooLarge: boolean;
	size: number;
	mtimeMs: number;
}

/** `PUT /api/fs/write`. When `expectedMtimeMs` mismatches the file on disk → 409 `conflict` with `FsWriteConflict`. */
export interface FsWriteRequest {
	path: string;
	content: string;
	expectedMtimeMs?: number;
}
export interface FsWriteResult {
	path: string;
	mtimeMs: number;
	size: number;
}
export interface FsWriteConflict extends ApiError {
	error: "conflict";
	mtimeMs: number;
}

/**
 * `POST /api/fs/op`. `trash` moves into `~/.local/share/romp/trash/<id>/` and returns `trashId`
 * so the UI can offer Undo via `restore`.
 */
export type FsOpRequest =
	| { op: "mkdir"; path: string }
	| { op: "create"; path: string }
	| { op: "rename"; path: string; to: string }
	| { op: "trash"; path: string }
	| { op: "restore"; trashId: string };
export interface FsOpResult {
	path: string;
	trashId?: string;
}

/** `GET /api/fs/raw?path=` streams file bytes with a guessed content-type (image preview, download). */

// ───────────────────────────── Terminals ─────────────────────────────

export interface TermInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	createdAt: number;
	/** Number of attached WebSocket clients. */
	clients: number;
	exited: boolean;
	exitCode: number | null;
}

/** `GET /api/terms` → `TermInfo[]`; `POST /api/terms` body `TermCreate` → `TermInfo`; `DELETE /api/terms/:id` kills. */
export interface TermCreate {
	cwd?: string;
	cols: number;
	rows: number;
	/** Command to run instead of the login shell, argv form. */
	command?: string[];
	title?: string;
}

/** Client → server on `/ws/term/:id`. */
export type TermClientMsg = { t: "in"; d: string } | { t: "resize"; cols: number; rows: number };

/**
 * Server → client on `/ws/term/:id`. On connect the server sends exactly one `replay`
 * (scrollback ring buffer, ≤ 2 MiB) before any `out`.
 */
export type TermServerMsg =
	| { t: "replay"; d: string; cols: number; rows: number }
	| { t: "out"; d: string }
	| { t: "resize"; cols: number; rows: number }
	| { t: "exit"; code: number | null };

// ───────────────────────────── Agents (OMP RPC bridge) ─────────────────────────────

export interface AgentInfo {
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	/** Agent turn in flight (between `agent_start` and `agent_end`). */
	busy: boolean;
	clients: number;
	exited: boolean;
	exitCode: number | null;
	/** Present when `cwd` is a romp task worktree. */
	task: { repo: string; slug: string } | null;
}

/** `GET /api/agents` → `AgentInfo[]`; `POST /api/agents` body `AgentCreate` → `AgentInfo`; `DELETE /api/agents/:id`. */
export interface AgentCreate {
	cwd: string;
	title?: string;
	/** Sent as the first `prompt` once the process is ready. */
	prompt?: string;
}

/**
 * Client → server on `/ws/agent/:id`.
 * `rpc` carries a raw OMP RPC command object (see oh-my-pi docs/rpc.md), e.g.
 * `{type:"prompt",message}`, `{type:"steer",message}`, `{type:"follow_up",message}`, `{type:"abort"}`,
 * `{type:"get_state"}`. The gateway assigns/overwrites `id` and routes the response back to the sender only.
 * `ui` carries a raw `extension_ui_response` object answering an `extension_ui_request`.
 */
export type AgentClientMsg =
	| { t: "rpc"; reqId: string; cmd: Record<string, unknown> & { type: string } }
	| { t: "ui"; response: Record<string, unknown> & { type: "extension_ui_response" } };

/**
 * Server → client on `/ws/agent/:id`.
 * - `snapshot`: sent once on connect. `messages` is the session transcript (OMP `get_messages` data),
 *   `state` is OMP `get_state` data, `pendingUi` are unresolved `extension_ui_request` frames.
 * - `frame`: every OMP stdout frame except command responses, forwarded unchanged and broadcast to all clients.
 *   The gateway enables `set_event_filter { events: null, messageUpdates: "delta" }`, so `message_update`
 *   frames carry deltas, not the full accumulating message.
 * - `response`: the OMP response to this client's `rpc` message, correlated by `reqId`.
 * - `exit`: the OMP process ended.
 */
export type AgentServerMsg =
	| {
			t: "snapshot";
			info: AgentInfo;
			messages: unknown[];
			state: unknown;
			pendingUi: unknown[];
	  }
	| { t: "frame"; frame: Record<string, unknown> & { type: string } }
	| { t: "response"; reqId: string; success: boolean; data?: unknown; error?: string }
	| { t: "info"; info: AgentInfo }
	| { t: "exit"; code: number | null };

// ───────────────────────────── Repos & tasks (romp git automation) ─────────────────────────────

export type LandMode = "push" | "pr";

export interface RepoInfo {
	/** Hub repo name, e.g. `my-app` (hub path `<ROMP_ROOT>/hub/my-app.git`). */
	name: string;
	/** Upstream URL (GitHub) or null for hub-only repos. */
	remote: string | null;
	/** Integration branch mirrored from upstream, default `main`. */
	branch: string;
	/** `push`: merge queue pushes to upstream `branch`. `pr`: opens a PR with auto-merge. Default `push`. */
	land: LandMode;
	/** Commands from the repo's `.romp.toml`, overridable in hub settings. */
	setup: string | null;
	test: string | null;
	/** Whether the current user has a local clone (`~/romp/<name>.git`). */
	cloned: boolean;
}

export type TaskStatus =
	| "active" // being worked on
	| "conflict" // sync merge with integration branch stopped on conflicts; agent must resolve markers
	| "queued" // shipped, waiting in the merge queue
	| "landing" // merge queue is rebasing/testing it
	| "landed" // integrated upstream (or PR opened in `pr` mode)
	| "failed"; // merge queue rejected it (tests or unresolved conflict); see `landing.log`

export interface LandingState {
	state: "queued" | "landing" | "landed" | "failed";
	message: string;
	updatedAt: number;
	commit: string | null;
	prUrl: string | null;
	/** Tail of the failing step's output (≤ 16 KiB). */
	log: string | null;
}

export interface TaskInfo {
	repo: string;
	slug: string;
	/** `agent/<user>/<slug>` */
	branch: string;
	/** Absolute worktree path `~/romp/<repo>/<slug>`. */
	path: string;
	title: string;
	createdAt: number;
	status: TaskStatus;
	dirty: boolean;
	/** Commits ahead of / behind the hub integration branch. */
	ahead: number;
	behind: number;
	conflictFiles: string[];
	landing: LandingState | null;
}

/** `GET /api/repos` → `RepoInfo[]`. `POST /api/repos` body `RepoAdd` → `RepoInfo` (creates hub repo from upstream). */
export interface RepoAdd {
	url: string;
	name?: string;
	branch?: string;
}
/** `PUT /api/repos/:name/settings` body `RepoSettingsUpdate` → `RepoInfo`. */
export interface RepoSettingsUpdate {
	land?: LandMode;
	setup?: string | null;
	test?: string | null;
}

/** `GET /api/tasks` → `TaskInfo[]`. `POST /api/tasks` body `TaskCreate` → `TaskCreated`. */
export interface TaskCreate {
	repo: string;
	/** Human title; the slug is derived from it unless given. */
	title: string;
	slug?: string;
	/** When set, an agent session is started in the worktree with this as its first prompt. */
	prompt?: string;
}
export interface TaskCreated {
	task: TaskInfo;
	agent: AgentInfo | null;
}
/** `POST /api/tasks/:repo/:slug/ship` body `TaskShip` → `TaskInfo`. `DELETE /api/tasks/:repo/:slug` removes worktree + branch. */
export interface TaskShip {
	message?: string;
}

// ───────────────────────────── Ports (browser pane) ─────────────────────────────

/** `GET /api/ports` → TCP ports listening on loopback/any owned by this user, excluding the gateway itself. */
export interface ListeningPort {
	port: number;
	/** Process name when readable from /proc. */
	process: string | null;
}
