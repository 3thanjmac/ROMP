import type { InstalledCommit, UpdateResult, UpdateStatus } from "@romp/protocol";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError, forbidden } from "./http.ts";
import { errnoCode, isRecord } from "./util.ts";

/** State of deploy/bin/romp-update; missing where ROMP was not installed with deploy/install.sh. */
export const UPDATE_DIR = "/var/lib/romp-update";
const STATES: readonly UpdateResult["state"][] = ["current", "updated", "waiting", "paused", "failed"];

export interface UpdatesOptions {
	dir?: string;
	/** The installed checkout, for the installed commit's subject and date. */
	src?: string;
	/** Whether romp-update.service is running now. */
	serviceRunning?: () => Promise<boolean>;
}

/**
 * The Update button. The gateway never runs as root: it drops a file in romp-update's `requests/` directory (group
 * romp may write there), and romp-update.path starts the root service, which empties the directory when it begins.
 */
export class Updates {
	private readonly dir: string;
	private readonly src: string;
	private readonly serviceRunning: () => Promise<boolean>;

	constructor(
		private readonly user: string,
		opts: UpdatesOptions = {},
	) {
		this.dir = opts.dir ?? UPDATE_DIR;
		this.src = opts.src ?? "/opt/romp";
		this.serviceRunning = opts.serviceRunning ?? systemdServiceRunning;
	}

	async status(): Promise<UpdateStatus> {
		const requests = join(this.dir, "requests");
		try {
			await stat(requests);
		} catch (err) {
			if (errnoCode(err) === "ENOENT") return { available: false, running: false, installed: null, last: null };
			throw err;
		}
		const [waiting, running, installed, last] = await Promise.all([
			readdir(requests).then(
				(names) => names.length > 0,
				() => false,
			),
			this.serviceRunning(),
			this.installed(),
			this.last(),
		]);
		return { available: true, running: waiting || running, installed, last };
	}

	async request(): Promise<UpdateStatus> {
		try {
			await writeFile(join(this.dir, "requests", this.user), `${Date.now()}\n`, { mode: 0o660 });
		} catch (err) {
			const code = errnoCode(err);
			if (code === "ENOENT") throw new HttpError(404, "not_found", "This ROMP was not installed with install.sh, so it has no updates");
			if (code === "EACCES") {
				throw forbidden(
					`${this.user} is not in the romp group, so it can't start updates. Ask an admin to run deploy/add-user.sh for it.`,
				);
			}
			throw err;
		}
		return this.status();
	}

	private async installed(): Promise<InstalledCommit | null> {
		const sha = (await readFile(join(this.dir, "applied"), "utf8").catch(() => "")).trim();
		if (!/^[0-9a-f]{40}$/.test(sha)) return null;
		// Root owns the checkout, so git needs telling that reading it is fine.
		const proc = Bun.spawn(["git", "-c", `safe.directory=${this.src}`, "-C", this.src, "log", "-1", "--format=%ct%n%s", sha], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const [time = "", subject = ""] = out.split("\n");
		if (code !== 0) return { sha, subject: "", at: 0 };
		return { sha, subject, at: Number(time) * 1000 };
	}

	private async last(): Promise<UpdateResult | null> {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(join(this.dir, "last.json"), "utf8"));
		} catch {
			return null;
		}
		if (!isRecord(raw)) return null;
		const { state, message, at } = raw;
		if (!STATES.includes(state as UpdateResult["state"]) || typeof message !== "string" || typeof at !== "number") return null;
		return { state: state as UpdateResult["state"], message, at };
	}
}

/** A oneshot service is "activating" while it runs. */
async function systemdServiceRunning(): Promise<boolean> {
	const proc = Bun.spawn(["systemctl", "is-active", "romp-update.service"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return out.trim() === "activating";
}
