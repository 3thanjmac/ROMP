import { expect, test } from "bun:test";
import { parseChoice, parseModels } from "../src/agents/models.ts";

test("parses omp models --json: thinking only for reasoning models, in OMP's order, malformed rows skipped", () => {
	const json = {
		models: [
			{ provider: "anthropic", kind: "chat", id: "opus", name: "Opus", reasoning: true, thinking: ["max", "low", "bogus", "high"] },
			{ provider: "openrouter", kind: "chat", id: "nova", name: "", reasoning: false, thinking: null },
			{ provider: "openai", kind: "image", id: "img", name: "Image" },
			{ provider: "broken" },
		],
	};
	expect(parseModels(json)).toEqual([
		{ provider: "anthropic", id: "opus", name: "Opus", thinking: ["low", "high", "max"] },
		{ provider: "openrouter", id: "nova", name: "nova", thinking: [] },
	]);
	expect(parseModels({})).toEqual([]);
});

test("parseChoice accepts a model and/or level and rejects anything else", () => {
	expect(parseChoice({ model: null, level: null })).toEqual({ model: null, level: null });
	expect(parseChoice({ model: { provider: "a", id: "b", extra: 1 }, level: "xhigh" })).toEqual({
		model: { provider: "a", id: "b" },
		level: "xhigh",
	});
	expect(parseChoice({ model: null, level: "auto" })).toBeNull();
	expect(parseChoice({ model: { provider: "", id: "b" }, level: null })).toBeNull();
	expect(parseChoice({ level: null })).toBeNull();
});
