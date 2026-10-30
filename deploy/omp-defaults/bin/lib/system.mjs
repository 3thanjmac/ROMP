// Platform probes shared by the dev-server CLI and extensions (Linux, macOS, Windows).
// Plain Node ESM so both `node` (CLIs) and omp's Bun runtime (extensions) load it.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Trimmed stdout, or undefined when the command is missing, fails or times out.
 * `partial` keeps stdout of a non-zero exit: lsof and ps exit 1 when one requested pid is gone.
 */
export function run(command, args, timeout = 5000, partial = false) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      windowsHide: true
    }).trim();
  } catch (error) {
    return partial && typeof error.status === "number" ? String(error.stdout ?? "").trim() : undefined;
  }
}

function isInside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Linux: listening sockets from /proc/net, owners matched by /proc/<pid>/cwd. */
function linuxListeners(root) {
  const portByInode = new Map();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "0A") {
        portByInode.set(cols[9], parseInt(cols[1].split(":")[1], 16));
      }
    }
  }
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let fds = [];
    try {
      if (!isInside(readlinkSync(`/proc/${entry}/cwd`), root)) {
        continue;
      }
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    const ports = new Set();
    for (const fd of fds) {
      try {
        const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${entry}/fd/${fd}`))?.[1];
        if (inode && portByInode.has(inode)) {
          ports.add(portByInode.get(inode));
        }
      } catch {
        // fd closed while scanning.
      }
    }
    if (ports.size === 0) {
      continue;
    }
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    } catch {
      // Process exited.
    }
    for (const port of ports) {
      found.push({ port, pid: Number(entry), cmd });
    }
  }
  return found;
}

/** Parses `lsof -F pn` output into pid -> names. */
function lsofNames(output) {
  const byPid = new Map();
  let pid;
  for (const line of (output ?? "").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      byPid.set(pid, []);
    } else if (line.startsWith("n") && pid !== undefined) {
      byPid.get(pid).push(line.slice(1));
    }
  }
  return byPid;
}

/** macOS (and any system with lsof): listeners from lsof, owners matched by their cwd. */
function lsofListeners(root) {
  const listening = lsofNames(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  if (listening.size === 0) {
    return [];
  }
  const pids = [...listening.keys()].join(",");
  const cwds = lsofNames(run("lsof", ["-a", "-d", "cwd", "-p", pids, "-Fpn"], 5000, true));
  const commands = new Map();
  for (const line of (run("ps", ["-o", "pid=,command=", "-p", pids], 5000, true) ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) {
      commands.set(Number(match[1]), match[2].trim());
    }
  }
  const found = [];
  for (const [pid, names] of listening) {
    const cwd = cwds.get(pid)?.[0];
    if (!cwd || !isInside(cwd, root)) {
      continue;
    }
    for (const port of new Set(names.map((name) => Number(name.slice(name.lastIndexOf(":") + 1))))) {
      if (Number.isFinite(port)) {
        found.push({ port, pid, cmd: commands.get(pid) ?? "" });
      }
    }
  }
  return found;
}

/** Windows exposes no process cwd, so the owner's command line must name a path inside `root`. */
function windowsListeners(root) {
  // Absolute paths: a bare name would also be looked up in the cwd, which is the (untrusted) project.
  const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const portsByPid = new Map();
  for (const line of (run(join(system32, "netstat.exe"), ["-ano"]) ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    // A listener's remote address ends in :0 on every locale, unlike the translated state column.
    if (cols[0] === "TCP" && cols[2]?.endsWith(":0") && /^\d+$/.test(cols[4] ?? "")) {
      const port = Number(cols[1].slice(cols[1].lastIndexOf(":") + 1));
      portsByPid.set(cols[4], new Set([...(portsByPid.get(cols[4]) ?? []), port]));
    }
  }
  if (portsByPid.size === 0) {
    return [];
  }
  const filter = [...portsByPid.keys()].map((pid) => `ProcessId=${pid}`).join(" OR ");
  const json = run(
    join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
    ],
    3000
  );
  let procs = [];
  try {
    procs = [JSON.parse(json || "[]")].flat();
  } catch {
    return [];
  }
  const normalize = (text) => text.toLowerCase().replaceAll("/", "\\");
  const needle = `${normalize(root).replace(/\\$/, "")}\\`;
  const found = [];
  for (const proc of procs) {
    if (proc?.CommandLine && normalize(proc.CommandLine).includes(needle)) {
      for (const port of portsByPid.get(String(proc.ProcessId)) ?? []) {
        found.push({ port, pid: proc.ProcessId, cmd: proc.CommandLine });
      }
    }
  }
  return found;
}

/**
 * TCP listeners owned by processes running from inside `root`, sorted by port.
 * @returns {{ port: number, pid: number, cmd: string }[]}
 */
export function projectListeners(root) {
  const found =
    process.platform === "linux" ? linuxListeners(root) : IS_WINDOWS ? windowsListeners(root) : lsofListeners(root);
  return found.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** Git toplevel of `cwd` as a native absolute path, else `cwd` itself. */
export function projectRoot(cwd = process.cwd()) {
  return resolve(run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], 2000) || cwd);
}
