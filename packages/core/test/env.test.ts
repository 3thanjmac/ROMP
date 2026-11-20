import { afterEach, expect, test } from "bun:test";
import { assertMayUseRoot } from "../src/env.ts";
import { RompError } from "../src/errors.ts";

const allow = process.env.ROMP_ALLOW_LIVE;
afterEach(() => {
	if (allow === undefined) delete process.env.ROMP_ALLOW_LIVE;
	else process.env.ROMP_ALLOW_LIVE = allow;
});

test("a development copy may not use the live root unless told to", () => {
	delete process.env.ROMP_ALLOW_LIVE;
	const worktree = "/home/alice/romp/romp/fix-x/packages/core/src";
	expect(() => assertMayUseRoot("/srv/romp", worktree)).toThrow(RompError);
	expect(() => assertMayUseRoot("/srv/romp/", worktree)).toThrow(RompError);
	// /opt/romp-dev is a different checkout that merely shares the prefix.
	expect(() => assertMayUseRoot("/srv/romp", "/opt/romp-dev/packages/core/src")).toThrow(RompError);
	expect(() => assertMayUseRoot("/tmp/scratch-root", worktree)).not.toThrow();
	process.env.ROMP_ALLOW_LIVE = "1";
	expect(() => assertMayUseRoot("/srv/romp", worktree)).not.toThrow();
});

test("the installed checkout uses the live root", () => {
	delete process.env.ROMP_ALLOW_LIVE;
	expect(() => assertMayUseRoot("/srv/romp", "/opt/romp/packages/core/src")).not.toThrow();
});
