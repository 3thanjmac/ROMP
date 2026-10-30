import { expect, test } from "bun:test";
import { findGitWrite, findGitWriteInCode } from "../src/gitguard.ts";

test("blocks every git write subcommand romp owns", () => {
	for (const cmd of [
		"git commit -m x",
		"git push",
		"git pull --rebase",
		"git fetch origin",
		"git merge main",
		"git rebase -i HEAD~2",
		"git reset --hard",
		"git checkout -b x",
		"git switch main",
		"git stash",
		"git worktree add ../x",
		"git cherry-pick abc",
		"git restore src/a.ts",
		"git clean -fd",
		"git branch -D old",
		"git branch -m new",
		"git tag v1",
		"cd sub && git -C . commit -am wip",
		'bash -c "git push origin HEAD"',
		"echo $(git commit -m x)",
		"FOO=1 timeout 10 git push",
	])
		expect(findGitWrite(cmd)).not.toBeNull();
});

test("allows read-only git and non-git commands", () => {
	for (const cmd of ["git status", "git diff HEAD", "git log --oneline -5", "git show HEAD:a.ts", "git branch", "git branch --list", "git tag -l", "echo 'git push'", "grep -r 'git commit' ."])
		expect(findGitWrite(cmd)).toBeNull();
});

test("scans eval code", () => {
	expect(findGitWriteInCode('!git commit -m "x"')).not.toBeNull();
	expect(findGitWriteInCode('await Bun.$`git push`')).not.toBeNull();
	expect(findGitWriteInCode('subprocess.run(["git", "commit", "-m", "x"])')).not.toBeNull();
	expect(findGitWriteInCode('print("hello")')).toBeNull();
});
