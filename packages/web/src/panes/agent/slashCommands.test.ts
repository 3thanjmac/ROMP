import { describe, expect, it } from "vitest";
import type { AgentCommand } from "../../lib/agent/types";
import { slashCompletion } from "./slashCommands";

const catalog: AgentCommand[] = [
	{ name: "model", aliases: ["models"], description: "Show current model selection", source: "builtin" },
	{
		name: "fast",
		description: "Toggle fast mode",
		input: { hint: "[on|ultra|off|status]" },
		subcommands: [
			{ name: "on", description: "Enable fast mode (priority tier)" },
			{ name: "off", description: "Disable fast mode" },
			{ name: "ultra" },
			{ name: "status" },
		],
		source: "extension",
	},
	{ name: "compact", input: { hint: "[focus]" }, source: "builtin" },
	{ name: "commit", source: "skill" },
	{ name: "mo", source: "custom" },
	{ name: "plan", aliases: ["fastplan"], source: "file" },
	{ name: "comp", source: "builtin" },
];

const names = (text: string) => slashCompletion(text, catalog).items.map(i => i.name);

describe("slashCompletion: commands", () => {
	it("lists the whole catalog in OMP order for a bare slash", () => {
		const result = slashCompletion("/", catalog);
		expect(result.open).toBe(true);
		expect(result.items.map(i => i.name)).toEqual(catalog.map(c => c.name));
		expect(result.items[1]).toMatchObject({ source: "extension", hint: "[on|ultra|off|status]", description: "Toggle fast mode" });
	});

	it("filters by name and alias prefix, case-insensitively: exact, then name prefix, then alias prefix", () => {
		expect(names("/FA")).toEqual(["fast", "plan"]);
		expect(names("/mo")).toEqual(["mo", "model"]);
		expect(names("/co")).toEqual(["compact", "commit", "comp"]);
		expect(names("/comp")).toEqual(["comp", "compact"]);
	});

	it("offers nothing after leading whitespace or across lines", () => {
		expect(slashCompletion(" /mo", catalog).open).toBe(false);
		expect(slashCompletion("/mo\n", catalog).open).toBe(false);
		expect(slashCompletion("/model\nnext", catalog).open).toBe(false);
		expect(slashCompletion("hello", catalog).open).toBe(false);
	});

	it("closes when nothing matches", () => {
		expect(slashCompletion("/zzz", catalog)).toEqual({ open: false, items: [] });
	});

	it("closes on an exact terminal command with nothing longer to complete", () => {
		expect(slashCompletion("/commit", catalog).open).toBe(false);
		expect(slashCompletion("/models", catalog).open).toBe(false);
	});

	it("stays open with the exact command first when a longer command also matches", () => {
		const result = slashCompletion("/mo", catalog);
		expect(result.open).toBe(true);
		expect(result.items[0]?.name).toBe("mo");
	});

	it("keeps an exact command with subcommands open so completing it opens the next level", () => {
		expect(names("/fast")).toEqual(["fast", "plan"]);
	});

	it("completes to the canonical name with one trailing space, also from an alias", () => {
		expect(slashCompletion("/mod", catalog).items[0]?.insertText).toBe("/model ");
		expect(slashCompletion("/fastp", catalog).items[0]).toMatchObject({ name: "plan", insertText: "/plan " });
	});
});

describe("slashCompletion: subcommands", () => {
	it("lists a command's subcommands after `/name `", () => {
		const result = slashCompletion("/fast ", catalog);
		expect(result.open).toBe(true);
		expect(result.items.map(i => i.name)).toEqual(["on", "off", "ultra", "status"]);
		expect(result.items.every(i => i.source === "extension" && i.hint === undefined)).toBe(true);
	});

	it("filters subcommands by prefix, exact first, and completes canonically", () => {
		expect(names("/fast O")).toEqual(["on", "off"]);
		expect(names("/fast u")).toEqual(["ultra"]);
		const item = slashCompletion("/fast st", catalog).items[0];
		expect(item).toMatchObject({ name: "status", description: null, insertText: "/fast status " });
		expect(item?.command.name).toBe("fast");
		expect(item?.subcommand?.name).toBe("status");
	});

	it("closes on an exact terminal subcommand", () => {
		expect(slashCompletion("/fast on", catalog).open).toBe(false);
		expect(slashCompletion("/fast ultra", catalog).open).toBe(false);
	});

	it("closes after whitespace following a completed subcommand", () => {
		expect(slashCompletion("/fast on ", catalog).open).toBe(false);
		expect(slashCompletion("/fast o x", catalog).open).toBe(false);
	});

	it("closes after whitespace following a command without subcommands, or an unknown command", () => {
		expect(slashCompletion("/compact ", catalog).open).toBe(false);
		expect(slashCompletion("/model x", catalog).open).toBe(false);
		expect(slashCompletion("/nope ", catalog).open).toBe(false);
		expect(slashCompletion("/fast zz", catalog).open).toBe(false);
	});
});
