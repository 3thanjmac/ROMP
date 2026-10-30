import fs from "node:fs";
import path from "node:path";
import type { RompEnv } from "./env.ts";
import { ensureDir, writeFileAtomic } from "./fsutil.ts";

/**
 * Shared OMP settings. `deploy/omp-defaults/` mirrors `~/.omp/agent/`; `romp omp-defaults sync`
 * copies it into the user's agent directory without overwriting anything the user changed:
 *
 * - YAML/JSON files merge per setting. A setting follows the shipped default while the user's
 *   value still equals the default it was last given; once they change it, theirs is kept.
 * - Other files are replaced only while they still match the last shipped copy, and a file the
 *   user deleted is not restored.
 * - Model choices (`models.yml` and the model settings in `config.yml`) are never copied; each
 *   user picks them with `omp setup` or `/models`.
 *
 * The last applied defaults are kept under `~/.local/state/romp/omp-defaults` as the merge base.
 */

export const OMP_DEFAULTS_SOURCE = path.resolve(import.meta.dir, "../../../deploy/omp-defaults");

export interface OmpDefaultsPaths {
	/** Shipped defaults, laid out like `~/.omp/agent`. */
	source: string;
	/** The user's OMP agent directory. */
	agentDir: string;
	/** Copy of the defaults as last applied: the base for the next merge. */
	snapshot: string;
	/** Present when the user opted out of updates. */
	optOut: string;
}

export function ompDefaultsPaths(env: RompEnv, source = OMP_DEFAULTS_SOURCE): OmpDefaultsPaths {
	return {
		source,
		agentDir: path.join(env.home, ".omp", "agent"),
		snapshot: path.join(env.home, ".local", "state", "romp", "omp-defaults"),
		optOut: path.join(env.home, ".config", "romp", "omp-defaults.off"),
	};
}

export type OmpDefaultsChange = "created" | "updated" | "removed" | "kept";

export interface OmpDefaultsAction {
	/** Path relative to the agent directory. */
	file: string;
	change: OmpDefaultsChange;
	/** Settings applied (`updated`) or held back by the user's own values (`kept`), or why a file was kept. */
	detail?: string;
}

export interface OmpDefaultsResult {
	optedOut: boolean;
	actions: OmpDefaultsAction[];
}

/** Model files each user configures for themselves. */
const PERSONAL_FILES: Record<string, true> = { "models.yml": true, "models.yaml": true, "models.json": true };
const SETTINGS_FILES: Record<string, true> = { "config.yml": true, "config.yaml": true };
/**
 * Settings in `config.yml` that choose models or providers, plus per-person consent and OMP's
 * own onboarding state.
 */
const PERSONAL_SETTINGS: readonly (readonly string[])[] = [
	["modelRoles"],
	["modelPresets"],
	["modelTags"],
	["modelProviderOrder"],
	["modelRoleStorage"],
	["cycleOrder"],
	["enabledModels"],
	["disabledProviders"],
	["retry", "fallbackChains"],
	["dev", "autoqaConsent"],
	// Copying this would mark OMP's setup wizard (provider sign-in, model picker) as already done.
	["setupVersion"],
];
/** Agent → model overrides are shared only when they name roles (`@smol`), never concrete models. */
const AGENT_OVERRIDES = ["task", "agentModelOverrides"] as const;

const STRUCTURED_RE = /\.(ya?ml|json)$/;
/** Credentials, history and sessions: never shipped even if copied into the defaults by mistake. */
const STATE_RE = /\.db(-wal|-shm|-journal)?$/;

function shipped(rel: string): boolean {
	const parts = rel.split("/");
	const name = parts[parts.length - 1]!;
	if (name === ".gitkeep" || STATE_RE.test(name)) return false;
	if (parts.length === 1 && PERSONAL_FILES[name] === true) return false;
	return parts[0] !== "sessions";
}

/** Files below `dir` as `/`-separated relative paths; symlinks are followed. */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (abs: string, rel: string) => {
		let names: string[];
		try {
			names = fs.readdirSync(abs);
		} catch {
			return;
		}
		for (const name of names) {
			const childAbs = path.join(abs, name);
			const childRel = rel ? `${rel}/${name}` : name;
			const stat = fs.statSync(childAbs, { throwIfNoEntry: false });
			if (stat?.isDirectory()) walk(childAbs, childRel);
			else if (stat?.isFile()) out.push(childRel);
		}
	};
	walk(dir, "");
	return out;
}

function readBytes(file: string): Buffer | null {
	try {
		return fs.readFileSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);

function parseStructured(rel: string, text: string): JsonObject {
	const value = rel.endsWith(".json") ? JSON.parse(text) : (Bun.YAML.parse(text) ?? {});
	if (!isObject(value)) throw new Error("top level is not a mapping");
	return value as JsonObject;
}

function serialize(rel: string, value: JsonObject): string {
	if (rel.endsWith(".json")) return `${JSON.stringify(value, null, 2)}\n`;
	const text = Bun.YAML.stringify(value, null, 2);
	return text.endsWith("\n") ? text : `${text}\n`;
}

function getPath(obj: Json | undefined, keys: readonly string[]): Json | undefined {
	let cur = obj;
	for (const key of keys) {
		if (!isObject(cur) || !Object.hasOwn(cur, key)) return undefined;
		cur = cur[key];
	}
	return cur;
}

/** Set (or delete, for `undefined`) one setting. False when the user's file has a non-mapping in the way. */
function setPath(obj: JsonObject, keys: readonly string[], value: Json | undefined): boolean {
	const parents: JsonObject[] = [obj];
	let cur = obj;
	for (const key of keys.slice(0, -1)) {
		const next = cur[key];
		if (next === undefined) {
			if (value === undefined) return true;
			cur[key] = {};
		} else if (!isObject(next)) return false;
		cur = cur[key] as JsonObject;
		parents.push(cur);
	}
	const last = keys[keys.length - 1]!;
	if (value !== undefined) {
		cur[last] = value;
		return true;
	}
	delete cur[last];
	// Drop mappings this removal left empty.
	for (let i = parents.length - 1; i > 0 && Object.keys(parents[i]!).length === 0; i--) delete parents[i - 1]![keys[i - 1]!];
	return true;
}

/** Leaf settings: non-empty mappings are descended into; arrays and scalars are single values. */
function leafPaths(obj: JsonObject, prefix: string[] = [], out: string[][] = []): string[][] {
	for (const [key, value] of Object.entries(obj)) {
		const keys = [...prefix, key];
		if (isObject(value) && Object.keys(value).length > 0) leafPaths(value, keys, out);
		else out.push(keys);
	}
	return out;
}

function stripPersonal(rel: string, value: JsonObject): JsonObject {
	if (SETTINGS_FILES[rel] !== true) return value;
	const copy = structuredClone(value);
	for (const keys of PERSONAL_SETTINGS) setPath(copy, keys, undefined);
	const overrides = getPath(copy, AGENT_OVERRIDES);
	if (isObject(overrides)) {
		for (const [agent, selector] of Object.entries(overrides)) {
			const selectors = Array.isArray(selector) ? selector : [selector];
			if (!selectors.every((s) => typeof s === "string" && s.startsWith("@"))) {
				setPath(copy, [...AGENT_OVERRIDES, agent], undefined);
			}
		}
	}
	return copy;
}

interface Planned {
	action?: OmpDefaultsAction;
	/** Contents to write into the agent directory (`null` deletes the file). */
	write?: { data: string | Uint8Array; mode: number } | null;
}

/** Setting paths for a report line; a first sync can touch dozens, so long lists are cut short. */
function listSettings(paths: string[]): string {
	const LIMIT = 6;
	return paths.length <= LIMIT ? paths.join(", ") : `${paths.slice(0, LIMIT).join(", ")} and ${paths.length - LIMIT} more`;
}

function planStructured(rel: string, theirsText: string | null, baseText: string | null, target: string, sourceMode: number): Planned {
	const theirs = theirsText === null ? undefined : stripPersonal(rel, parseStructured(rel, theirsText));
	let base: JsonObject | undefined;
	try {
		base = baseText === null ? undefined : stripPersonal(rel, parseStructured(rel, baseText));
	} catch {
		base = undefined;
	}
	const mineText = readBytes(target)?.toString("utf8") ?? null;
	if (mineText === null) {
		if (base !== undefined) {
			return same(base, theirs) ? {} : { action: { file: rel, change: "kept", detail: "you deleted it" } };
		}
		if (theirs === undefined || Object.keys(theirs).length === 0) return {};
		return { action: { file: rel, change: "created" }, write: { data: serialize(rel, theirs), mode: sourceMode } };
	}
	let mine: JsonObject;
	try {
		mine = parseStructured(rel, mineText);
	} catch (err) {
		if (same(base, theirs)) return {};
		return { action: { file: rel, change: "kept", detail: `could not read your copy: ${(err as Error).message}` } };
	}
	const applied: string[] = [];
	const held: string[] = [];
	const seen = new Set<string>();
	for (const keys of [...leafPaths(base ?? {}), ...leafPaths(theirs ?? {})]) {
		const id = keys.join("\0");
		if (seen.has(id)) continue;
		seen.add(id);
		const baseValue = getPath(base, keys);
		const theirValue = getPath(theirs, keys);
		if (same(baseValue, theirValue)) continue;
		if (same(getPath(mine, keys), baseValue) && setPath(mine, keys, theirValue)) applied.push(keys.join("."));
		else held.push(keys.join("."));
	}
	if (applied.length === 0) {
		return held.length ? { action: { file: rel, change: "kept", detail: `your values for ${listSettings(held)}` } } : {};
	}
	const detail = held.length ? `${listSettings(applied)}; kept your ${listSettings(held)}` : listSettings(applied);
	const mode = fs.statSync(target).mode & 0o777;
	if (Object.keys(mine).length === 0) return { action: { file: rel, change: "removed", detail }, write: null };
	return { action: { file: rel, change: "updated", detail }, write: { data: serialize(rel, mine), mode } };
}

function planFile(theirs: Buffer | null, base: Buffer | null, rel: string, target: string, sourceMode: number): Planned {
	const mine = readBytes(target);
	if (theirs && mine && theirs.equals(mine)) return {};
	const defaultChanged = !(base && theirs ? base.equals(theirs) : base === theirs);
	if (mine === null) {
		if (theirs === null) return {};
		if (base !== null) return defaultChanged ? { action: { file: rel, change: "kept", detail: "you deleted it" } } : {};
		return { action: { file: rel, change: "created" }, write: { data: theirs, mode: sourceMode } };
	}
	if (base !== null && base.equals(mine)) {
		if (theirs === null) return { action: { file: rel, change: "removed" }, write: null };
		return { action: { file: rel, change: "updated" }, write: { data: theirs, mode: fs.statSync(target).mode & 0o777 } };
	}
	if (!defaultChanged) return {};
	return { action: { file: rel, change: "kept", detail: theirs === null ? "no longer shipped; your edited copy stays" : "you edited it" } };
}

/** Apply the shipped defaults to one user's agent directory (or, with `dryRun`, report what would change). */
export function syncOmpDefaults(paths: OmpDefaultsPaths, opts: { dryRun?: boolean } = {}): OmpDefaultsResult {
	if (fs.existsSync(paths.optOut)) return { optedOut: true, actions: [] };
	const theirsFiles = listFiles(paths.source).filter(shipped);
	const files = [...new Set([...theirsFiles, ...listFiles(paths.snapshot).filter(shipped)])].sort();
	const actions: OmpDefaultsAction[] = [];
	const snapshot: { rel: string; data: string | Uint8Array }[] = [];
	for (const rel of files) {
		const src = path.join(paths.source, rel);
		const target = path.join(paths.agentDir, rel);
		const theirs = readBytes(src);
		const base = readBytes(path.join(paths.snapshot, rel));
		const sourceMode = theirs === null ? 0o644 : fs.statSync(src).mode & 0o755;
		let planned: Planned;
		if (STRUCTURED_RE.test(rel)) {
			let theirsText: string | null = null;
			if (theirs !== null) {
				theirsText = theirs.toString("utf8");
				try {
					snapshot.push({ rel, data: serialize(rel, stripPersonal(rel, parseStructured(rel, theirsText))) });
				} catch (err) {
					throw new Error(`${src}: ${(err as Error).message}`);
				}
			}
			planned = planStructured(rel, theirsText, base?.toString("utf8") ?? null, target, sourceMode);
		} else {
			if (theirs !== null) snapshot.push({ rel, data: theirs });
			planned = planFile(theirs, base, rel, target, sourceMode);
		}
		if (planned.action) actions.push(planned.action);
		if (opts.dryRun || planned.write === undefined) continue;
		if (planned.write === null) fs.rmSync(target, { force: true });
		else {
			ensureDir(path.dirname(target));
			writeFileAtomic(target, planned.write.data, planned.write.mode);
		}
	}
	if (!opts.dryRun) {
		fs.rmSync(paths.snapshot, { recursive: true, force: true });
		for (const { rel, data } of snapshot) {
			const file = path.join(paths.snapshot, rel);
			ensureDir(path.dirname(file));
			writeFileAtomic(file, data, 0o644);
		}
	}
	return { optedOut: false, actions };
}

/** Stop (`true`) or resume (`false`) receiving shared OMP settings. */
export function setOmpDefaultsOptOut(paths: OmpDefaultsPaths, optOut: boolean): void {
	if (!optOut) {
		fs.rmSync(paths.optOut, { force: true });
		return;
	}
	ensureDir(path.dirname(paths.optOut));
	fs.writeFileSync(paths.optOut, "Shared OMP settings are off for this user. `romp omp-defaults on` resumes them.\n");
}
