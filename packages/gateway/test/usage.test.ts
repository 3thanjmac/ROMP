import { expect, test } from "bun:test";
import type { UsageProvider } from "@romp/protocol";
import { attributeUsage, currentShares, parseUsageReport, type Spend, type UsageBook } from "../src/agents/usage.ts";

const SAMPLE = {
	generatedAt: 1793668348112,
	reports: [
		{
			provider: "anthropic",
			fetchedAt: 1793668323152,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 18000000, resetsAt: 1793682000000 },
					amount: { used: 6, limit: 100, remaining: 94, usedFraction: 0.06, remainingFraction: 0.94, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					scope: { provider: "anthropic", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 Day", durationMs: 604800000, resetsAt: 1793916000000 },
					amount: { used: 28.999999999999996, limit: 100, remaining: 71, usedFraction: 0.29, remainingFraction: 0.71, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 0, unit: "usd", limit: 50, remaining: 50, usedFraction: 0, remainingFraction: 1 },
					status: "ok",
				},
			],
			metadata: { accountId: "acct-1", email: "someone@gmail.com", orgName: "Org" },
		},
	],
	accountsWithoutUsage: [],
	disabledCredentials: [],
	capacity: {},
};

test("parses omp usage --json", () => {
	expect(parseUsageReport(SAMPLE)).toEqual([
		{
			provider: "anthropic",
			account: "someone@gmail.com",
			fetchedAt: 1793668323152,
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					windowLabel: "5 Hour",
					usedFraction: 0.06,
					used: 6,
					limit: 100,
					unit: "percent",
					resetsAt: 1793682000000,
					status: "ok",
				},
				{
					id: "anthropic:7d",
					label: "Claude 7 Day",
					windowLabel: "7 Day",
					usedFraction: 0.29,
					used: 28.999999999999996,
					limit: 100,
					unit: "percent",
					resetsAt: 1793916000000,
					status: "ok",
				},
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					windowLabel: null,
					usedFraction: 0,
					used: 0,
					limit: 50,
					unit: "usd",
					resetsAt: null,
					status: "ok",
				},
			],
		},
	]);
	expect(() => parseUsageReport({ nope: true })).toThrow();
	// Malformed limits are skipped, missing fractions are derived.
	const [provider] = parseUsageReport({ reports: [{ provider: "x", limits: [null, { id: "x:1", amount: { used: 5, limit: 20 } }] }] });
	expect(provider?.limits).toMatchObject([{ id: "x:1", usedFraction: 0.25, resetsAt: null }]);
});

const H5 = 1_800_000_000_000;
const D7 = 1_800_400_000_000;

function report(fiveHour: number, sevenDay: number, resets5h = H5, resets7d = D7): UsageProvider[] {
	const limit = (id: string, usedFraction: number, resetsAt: number) => ({
		id,
		label: id,
		windowLabel: null,
		usedFraction,
		used: usedFraction * 100,
		limit: 100,
		unit: "percent",
		resetsAt,
		status: "ok",
	});
	return [
		{
			provider: "anthropic",
			account: null,
			fetchedAt: 0,
			limits: [limit("anthropic:5h", fiveHour, resets5h), limit("anthropic:7d", sevenDay, resets7d)],
		},
	];
}

const spend = (entries: Record<string, number>): Spend =>
	new Map(Object.entries(entries).map(([agent, usd]) => [agent, new Map([["anthropic", usd]])]));

test("splits an interval's increase across agents by what each spent", () => {
	const changed = attributeUsage(report(0.1, 0.3), report(0.2, 0.34), spend({ a: 3, b: 1 }), new Map());
	expect(changed.get("a")?.["anthropic:5h"]?.share).toBeCloseTo(0.075);
	expect(changed.get("b")?.["anthropic:5h"]?.share).toBeCloseTo(0.025);
	expect(changed.get("a")?.["anthropic:7d"]?.share).toBeCloseTo(0.03);
	expect(changed.get("b")?.["anthropic:7d"]?.share).toBeCloseTo(0.01);

	// Shares accumulate over intervals of the same window, even when the provider nudges `resetsAt`.
	const books = new Map(changed);
	const next = attributeUsage(report(0.2, 0.34), report(0.3, 0.36, H5 + 30_000), spend({ a: 2 }), books);
	expect(next.get("a")?.["anthropic:5h"]).toEqual({ share: expect.closeTo(0.175), resetsAt: H5 + 30_000 });
	expect(next.has("b")).toBe(false);
});

test("an interval without ROMP spend or with a falling limit attributes nothing", () => {
	const book: UsageBook = { "anthropic:5h": { share: 0.05, resetsAt: H5 } };
	expect(attributeUsage(report(0.1, 0.3), report(0.4, 0.5), new Map(), new Map([["a", book]])).size).toBe(0);
	expect(attributeUsage(report(0.1, 0.3), report(0.4, 0.5), spend({ a: 0 }), new Map()).size).toBe(0);
	expect(attributeUsage(report(0.4, 0.3), report(0.2, 0.3), spend({ a: 5 }), new Map()).size).toBe(0);
});

test("a window reset drops shares of the old window and starts a fresh one", () => {
	const later = H5 + 5 * 3_600_000;
	const books = new Map<string, UsageBook>([
		["a", { "anthropic:5h": { share: 0.2, resetsAt: H5 }, "anthropic:7d": { share: 0.05, resetsAt: D7 } }],
		["b", { "anthropic:5h": { share: 0.1, resetsAt: H5 } }],
	]);
	// The 5h window rolled over: everything used in it is new, split by spend; b spent nothing and loses its old share.
	const changed = attributeUsage(report(0.5, 0.3), report(0.04, 0.32, later), spend({ a: 1 }), books);
	expect(changed.get("a")).toEqual({
		"anthropic:5h": { share: expect.closeTo(0.04), resetsAt: later },
		"anthropic:7d": { share: expect.closeTo(0.07), resetsAt: D7 },
	});
	expect(changed.get("b")).toEqual({});

	// A book that was not updated since a reset reports 0 for that window.
	expect(currentShares(books.get("b"), report(0.04, 0.32, later))).toEqual({ "anthropic:5h": 0, "anthropic:7d": 0 });
	expect(currentShares(books.get("a"), report(0.5, 0.3))).toEqual({ "anthropic:5h": 0.2, "anthropic:7d": 0.05 });
});
