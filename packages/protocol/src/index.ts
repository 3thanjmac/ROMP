/**
 * Wire contract between the ROMP gateway (Bun, runs on the VM) and the web shell (Svelte SPA).
 *
 * Transport rules:
 * - HTTP JSON under `/api/*`. Errors are `ApiError` bodies with a non-2xx status.
 * - One WebSocket per live resource: `/ws/term/:id`, `/ws/agent/:id`. Messages are JSON text frames.
 * - Dev-server proxy: `/proxy/:port/*` strips the prefix; `/absproxy/:port/*` forwards the full path
 *   (for apps configured with a matching base path, e.g. `vite --base /absproxy/5173/`). Both upgrade WebSockets.
 * - Static SPA is served from `/` with history fallback to `index.html`.
 * - Connections through the LAN proxy (not Tailscale) need a session cookie from `POST /api/login`. Until then
 *   only the static SPA and `/api/login` answer; everything else is 401 `login_required`.
 */

// ───────────────────────────── Common ─────────────────────────────

export interface ApiError {
	/** Stable machine code, e.g. `not_found`, `conflict`, `forbidden`, `bad_request`, `git_failed`. */
	error: string;
	/** Human-readable explanation, safe to show in a toast. */
	message: string;
}

/** `POST /api/login` (LAN connections only). 204 with a session cookie; 401 `bad_password`, 429 `rate_limited`, 403 when no password is set. */
export interface LoginRequest {
	password: string;
}

/** `GET /api/me` */
export interface Me {
	/** Tailscale login (`Tailscale-User-Login` header), the Linux user when signed in over the LAN, or `dev` when auth is disabled. */
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

/**
 * `GET /api/git-identity`: the user's global git `user.name` and `user.email`, which author their commits;
 * empty strings when unset. `PUT /api/git-identity` takes a `Partial<GitIdentity>` of non-empty values and
 * answers with the result.
 */
export interface GitIdentity {
	name: string;
	email: string;
}

// ───────────────────────────── Shell layout ─────────────────────────────

export type WindowKind = "terminal" | "files" | "editor" | "agent" | "browser" | "tasks";

export interface TerminalProps {
	/** Gateway terminal session id; absent until the session is created. */
	termId?: string;
	cwd?: string;
	/** Command run instead of the login shell, argv form. Restarting the window runs it again. */
	command?: string[];
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
	/** Folder whose dev server the window starts and previews (the focused window's directory when opened). */
	cwd?: string;
	/** One-shot request (Tasks Preview): start `cwd`'s dev server and load it when ready. The pane clears it. */
	start?: boolean;
}
export interface TasksProps {
	repo?: string;
	/**
	 * One-shot request from another window: open this repo's settings dialog at its Dev command. The Tasks pane
	 * clears it once handled.
	 */
	settings?: string;
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

/**
 * `PUT /api/fs/upload?path=<dir>&name=<file>[&overwrite=1]`, body: the file's raw bytes as
 * `application/octet-stream` (never multipart, which a cross-site form can send without a preflight) → `FsWriteResult`.
 * 409 `conflict` when `name` exists and `overwrite` is absent; 413 `too_large` above 1 GiB. The bytes land in a
 * temporary file next to the target and are renamed into place, so a dropped connection leaves nothing behind.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

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

/** `GET /api/agents/:id/usage` */
export interface AgentUsage {
	/** The session's current model when OMP is running (from `get_state.model`), else the last one seen, else null. */
	model: { provider: string; id: string; name: string | null } | null;
	/** Account limits from `omp usage --json`; null with `limitsError` set when the fetch failed. */
	limits: UsageProvider[] | null;
	limitsError: string | null;
	/** This chat. `stats` is null when OMP is not running and nothing was recorded yet. */
	chat: {
		stats: {
			tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			/** USD, as OMP prices the session. */
			cost: number;
			context: { tokens: number; window: number; fraction: number } | null;
		} | null;
		/**
		 * Estimated share of each limit window this chat consumed in the CURRENT window, keyed by `UsageLimit.id`.
		 * Fractions of the whole limit (0..1), same scale as `UsageLimit.usedFraction`. Limits are account-wide, so the
		 * gateway splits each increase between turn-boundary samples across chats by the USD each spent meanwhile.
		 */
		shares: Record<string, number>;
	};
}

/** OMP's thinking effort, lowest first. `off` disables thinking. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** `GET /api/models` → `ModelOption[]`: the chat models `omp models --json` lists, in its order. */
export interface ModelOption {
	provider: string;
	id: string;
	name: string;
	/** Efforts the model accepts besides `off`; empty when it has no thinking control. */
	thinking: ThinkingLevel[];
}

/**
 * A model and thinking effort to run with. Null fields keep what OMP would use (its default model, the model's default effort).
 * `GET /api/agents/:id/thinking` → the session's current choice (never spawns OMP).
 * `PUT /api/agents/:id/thinking` with a choice → switches the session, then reports what OMP chose.
 */
export interface ModelChoice {
	model: { provider: string; id: string } | null;
	level: ThinkingLevel | null;
}

/** One provider's account limits, as `omp usage --json` reports them. */
export interface UsageProvider {
	/** OMP provider id, e.g. `anthropic`. */
	provider: string;
	/** Account email or id, if reported. */
	account: string | null;
	fetchedAt: number;
	limits: UsageLimit[];
}

export interface UsageLimit {
	/** e.g. `anthropic:5h` */
	id: string;
	/** OMP's label, e.g. `Claude 5 Hour`. */
	label: string;
	/** e.g. `5 Hour`; null for limits without a window. */
	windowLabel: string | null;
	/** 0..1 when known. */
	usedFraction: number | null;
	used: number | null;
	limit: number | null;
	/** `percent`, `usd`, ... as OMP reports it. */
	unit: string;
	/** Epoch ms; null when the window has not started or has no reset. */
	resetsAt: number | null;
	/** OMP's status, e.g. `ok`. */
	status: string;
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
 * - `error`: OMP could not start (`message` is its explanation, e.g. no model configured). Sent right before the
 *   gateway closes the socket with code 4503; the client should not reconnect until the user retries.
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
	| { t: "exit"; code: number | null }
	| { t: "error"; message: string };

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
	/**
	 * Effective commands: hub settings, else the repo's `.romp.toml` on `branch`, else detected from its files
	 * (lockfile → install for `setup`, package.json `test`/`dev` scripts). Null when unset or disabled.
	 */
	setup: string | null;
	test: string | null;
	dev: string | null;
	/** Where each command comes from, for the settings UI. */
	commands: Record<RepoCommandName, RepoCommandSource>;
	/** Whether the current user has a local clone (`~/romp/<name>.git`). */
	cloned: boolean;
	/** The current user uploaded a `.env` for this repo; every new task worktree gets a copy. */
	env: boolean;
}

/** `setup` runs in every new task worktree, the merge queue runs `setup` + `test`, Start dev server runs `dev`. */
export type RepoCommandName = "setup" | "test" | "dev";

export interface RepoCommandSource {
	/** `settings`: hub override; `repo`: `.romp.toml`; `detected`: lockfile / package.json. Null when none applies. */
	source: "settings" | "repo" | "detected" | null;
	/** The command without a hub override (what Reset restores): `.romp.toml`, else detected. */
	fallback: string | null;
	fallbackSource: "repo" | "detected" | null;
	/** File a detected fallback came from, e.g. `pnpm-lock.yaml` or `package.json`. */
	detectedFrom: string | null;
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
	/** The repo's setup command run in the new worktree; null when it never ran (no command). */
	setup: TaskSetup | null;
}

/**
 * `POST /api/tasks/:repo/:slug/setup` → `TaskInfo`: runs the setup command again in a new terminal. 409 while it is
 * running, 422 `no_setup_command` when the repo has none.
 */
export interface TaskSetup {
	state: "running" | "failed" | "done";
	/** Terminal running (or that ran) the command, while the gateway still has it; attach to it for the log. */
	termId: string | null;
	exitCode: number | null;
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
	/** null drops the hub override (falls back to `.romp.toml`, then detection); "" disables the command. */
	setup?: string | null;
	test?: string | null;
	dev?: string | null;
	/** New integration branch. Must exist upstream (fetched into the hub) or, for hub-only repos, in the hub. */
	branch?: string;
}
/**
 * `GET /api/repos/:name/branches` → `RepoBranches`: upstream heads (`git ls-remote --heads`) for repos with a
 * remote, hub heads for hub-only repos. romp's own `agent/*` and `land/*` branches are left out. Sorted, `current` first.
 */
export interface RepoBranches {
	current: string;
	branches: string[];
}
/**
 * `PUT /api/repos/:name/env`, body: the `.env` file's raw bytes as `application/octet-stream` (≤ 64 KiB) → `RepoInfo`.
 * `DELETE /api/repos/:name/env` → `RepoInfo`. Stored per user at `~/.config/romp/env/<name>.env` (mode 0600), copied
 * into new task worktrees as `.env`, and kept out of commits by the clone's `info/exclude`.
 *
 * `DELETE /api/repos/:name` → 204: removes the hub repo, its settings and status, and this user's clone, task
 * worktrees, agents and `.env`. 409 `conflict` while another user still has task branches in the hub or a landing
 * for the repo is queued or running.
 */
export const MAX_ENV_BYTES = 64 * 1024;
/**
 * `GET /api/repos/search?q=` → `RepoSuggestion[]` (≤ 20): GitHub repos the gateway user's `gh` account owns,
 * collaborates on or reaches through an organization, most recently pushed first, filtered by `q` (case-insensitive
 * match on `fullName`). 503 `gh_unavailable` when the gh CLI is missing or signed out.
 */
export interface RepoSuggestion {
	/** `owner/name` */
	fullName: string;
	/** HTTPS clone URL. */
	url: string;
	description: string | null;
	private: boolean;
	/** Last push, epoch ms. */
	pushedAt: number;
}

/** `GET /api/tasks` → `TaskInfo[]`. `POST /api/tasks` body `TaskCreate` → `TaskCreated`. */
export interface TaskCreate {
	repo: string;
	/** Human title; the slug is derived from it unless given. */
	title: string;
	slug?: string;
	/** When set, an agent session is started in the worktree with this as its first prompt. */
	prompt?: string;
	/**
	 * `title` was derived from the prompt rather than typed. With a `prompt`, the gateway then asks OMP (its `tiny`
	 * model role) for a short title in the background and renames the task, its agent and the OMP session to it,
	 * capped by `autoTitle`. The slug keeps the first title.
	 */
	autoTitle?: boolean;
	/** Model and effort for the agent's session, applied before the first prompt. */
	thinking?: ModelChoice;
}
export interface TaskCreated {
	task: TaskInfo;
	agent: AgentInfo | null;
}
/** `POST /api/tasks/:repo/:slug/ship` body `TaskShip` → `TaskInfo`. `DELETE /api/tasks/:repo/:slug` removes worktree + branch. */
export interface TaskShip {
	message?: string;
}

/** Word cap for titles romp picks on its own (from the prompt, or generated by OMP). */
export const AUTO_TITLE_WORDS = 5;

/** First non-empty line of `text`, cut to `AUTO_TITLE_WORDS` words with a trailing ellipsis when longer. */
export function autoTitle(text: string): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
	const words = line.split(/\s+/).filter(Boolean);
	if (words.length <= AUTO_TITLE_WORDS) return words.join(" ");
	return `${words.slice(0, AUTO_TITLE_WORDS).join(" ").replace(/[\s.,;:!?…-]+$/, "")}…`;
}

// ───────────────────────────── Ports (browser pane) ─────────────────────────────

/** `GET /api/ports` → TCP ports listening on loopback/any owned by this user, excluding the gateway itself. */
export interface ListeningPort {
	port: number;
	/** Process name when readable from /proc. */
	process: string | null;
}

// ───────────────────────────── Dev servers (browser pane) ─────────────────────────────

/**
 * A folder's dev command running in a gateway terminal (`termId`, attachable like any terminal).
 * `GET /api/dev` → `DevServerInfo[]`. `POST /api/dev` body `DevServerStart` → `DevServerInfo`: the server already
 * running in that folder, else a new one; 422 `no_dev_command` when the folder has none.
 * `DELETE /api/dev/:id` → 204 once its whole process tree is gone (SIGTERM, SIGKILL after 5 s); the terminal goes too.
 * `ready` means a process under the terminal listens on `port` (the lowest below 10000 when there are several).
 * Exited servers stay listed for a minute, then drop out.
 */
export interface DevServerInfo {
	id: string;
	/** Real path. */
	cwd: string;
	command: string;
	termId: string;
	port: number | null;
	state: "starting" | "ready" | "exited";
	exitCode: number | null;
	startedAt: number;
}

export interface DevServerStart {
	cwd: string;
}

/** `GET /api/dev/command?cwd=` → the command Start would run in `cwd`, without starting it. */
export interface DevCommand {
	/** Real path, as `DevServerInfo.cwd` reports it. */
	cwd: string;
	command: string | null;
	/** Repo whose task worktree holds `cwd` (its settings set the command); null outside tasks. */
	repo: string | null;
}

// ───────────────────────────── Sign-in callback ─────────────────────────────

/**
 * `POST /api/callback` body. CLIs signing in with OAuth (wrangler, codex, vercel…) wait on a loopback port for the
 * browser's redirect; the browser is on another device, so the gateway delivers that address on the VM instead.
 * `url` must pass {@link parseLoopbackCallback}. 404 `nothing_listening` when no process of the signed-in user
 * listens on its port, 502 when the request fails.
 */
export interface CallbackRequest {
	url: string;
}

/** `POST /api/callback` → what the waiting program answered: its HTTP status and a short plain-text excerpt. */
export interface CallbackResult {
	status: number;
	message: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A sign-in callback address: `http:` on localhost, 127.0.0.1 or [::1] with an explicit port, no credentials.
 * Browsers hide `http://` in the address bar and often copy without it, so a bare `localhost:8976/…` counts.
 */
export function parseLoopbackCallback(text: string): { url: URL; port: number } | null {
	const trimmed = text.trim();
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname) || url.username || url.password) return null;
	// `URL` drops a port equal to the scheme default, so `:80` reads as no port; nothing unprivileged listens there.
	if (!url.port) return null;
	return { url, port: Number(url.port) };
}

// ───────────────────────────── Push notifications ─────────────────────────────

/** `GET /api/push`: the VAPID key a browser subscribes with (`applicationServerKey`), base64url. */
export interface PushConfig {
	publicKey: string;
}

/** `PUT /api/push/subscription` body: a browser `PushSubscription.toJSON()`. 204; re-sending one is harmless. */
export interface PushSubscriptionInput {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** `DELETE /api/push/subscription` and `POST /api/push/test` (502 `push_failed` with the push service's answer) body. */
export interface PushEndpoint {
	endpoint: string;
}

/**
 * `PUT /api/push/presence` body, 204. A device reports `active` every 15 s while ROMP is visible and focused, and
 * `false` when it stops being so; the gateway skips pushes to it until 40 s after the last `active` report.
 */
export interface PushPresence {
	endpoint: string;
	active: boolean;
}

/** The decrypted push payload the service worker shows. `tag` groups notifications (one per agent). */
export interface PushMessage {
	title: string;
	body: string;
	tag: string;
	/** Agent to open when the notification is tapped. */
	agentId: string | null;
	cwd: string | null;
}
