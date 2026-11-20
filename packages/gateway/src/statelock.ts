import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errnoCode } from "./util.ts";

/**
 * Claims `<stateDir>/gateway.pid` so two gateways never share a state directory: a second one (say, a test gateway
 * started from a ROMP worktree) would load the first one's agents, sessions and push subscriptions and then
 * overwrite them. A claim whose process is gone is taken over. Returns the release, for shutdown.
 */
export function claimStateDir(stateDir: string): () => void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const file = join(stateDir, "gateway.pid");
	const mine = `${process.pid} ${startTime(process.pid)}`;
	for (; ;) {
		try {
			writeFileSync(file, `${mine}\n`, { flag: "wx", mode: 0o600 });
			break;
		} catch (err) {
			if (errnoCode(err) !== "EEXIST") throw err;
		}
		let holder: string;
		try {
			holder = readFileSync(file, "utf8").trim();
		} catch (err) {
			if (errnoCode(err) === "ENOENT") continue;
			throw err;
		}
		const [pid = "", started = ""] = holder.split(" ");
		// The start time tells a live holder from an unrelated process that got its pid after a crash or reboot.
		if (started && startTime(Number(pid)) === started) {
			throw new Error(`another romp-gateway (pid ${pid}) uses ${stateDir}; give this one its own state_dir`);
		}
		rmSync(file, { force: true });
	}
	return () => {
		try {
			if (readFileSync(file, "utf8").trim() === mine) rmSync(file, { force: true });
		} catch {
			// Already gone.
		}
	};
}

/** Field 22 of /proc/<pid>/stat (clock ticks after boot), or "" when there is no such process. */
function startTime(pid: number): string {
	if (!Number.isInteger(pid) || pid <= 0) return "";
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) is in parentheses and may contain spaces; fields 3 onward follow ") ".
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
	} catch {
		return "";
	}
}
