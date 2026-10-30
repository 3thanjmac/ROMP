import { describe, expect, test } from "bun:test";
import { ChunkDecoder, FrameError, LineSplitter, MAX_FRAME_BYTES } from "../src/agents/frames.ts";

const CHUNK = 256 * 1024;

/** Encodes `frame` the way OMP protocol v2 does for oversized frames. */
function chunks(frame: object, chunkId = "rpc-1"): Record<string, unknown>[] {
	const bytes = Buffer.from(JSON.stringify(frame), "utf8");
	const count = Math.ceil(bytes.byteLength / CHUNK);
	return Array.from({ length: count }, (_, index) => ({
		type: "rpc_chunk",
		chunkId,
		index,
		count,
		byteLength: bytes.byteLength,
		data: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString("base64"),
	}));
}

const big = { type: "response", id: "g1", success: true, data: "é".repeat(MAX_FRAME_BYTES) };

describe("LineSplitter", () => {
	test("splits lines across reads, including a multibyte character split between reads", () => {
		const splitter = new LineSplitter();
		const bytes = Buffer.from('{"a":"é"}\n\n{"b":1}\n{"c"', "utf8");
		const cut = bytes.indexOf(0xc3) + 1;
		expect(splitter.push(bytes.subarray(0, cut))).toEqual([]);
		expect(splitter.push(bytes.subarray(cut))).toEqual(['{"a":"é"}', '{"b":1}']);
		expect(splitter.push(Buffer.from(":2}\n"))).toEqual(['{"c":2}']);
	});
	test("rejects invalid UTF-8 and lines over the physical frame limit", () => {
		expect(() => new LineSplitter().push(Uint8Array.of(0x7b, 0xff, 0x7d, 0x0a))).toThrow(FrameError);
		expect(() => new LineSplitter().push(new Uint8Array(MAX_FRAME_BYTES).fill(0x20))).toThrow(FrameError);
	});
});

describe("ChunkDecoder", () => {
	test("passes ordinary frames through", () => {
		expect(new ChunkDecoder().push({ type: "agent_start" })).toEqual({ type: "agent_start" });
	});
	test("reassembles an oversized frame", () => {
		const decoder = new ChunkDecoder();
		const parts = chunks(big);
		expect(parts.length).toBeGreaterThan(2);
		const results = parts.map((part) => decoder.push(part));
		expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
		expect(results.at(-1)).toEqual(big);
	});
	test("rejects a sequence interrupted by another frame", () => {
		const decoder = new ChunkDecoder();
		const parts = chunks(big);
		decoder.push(parts[0]);
		expect(() => decoder.push({ type: "agent_start" })).toThrow("interrupted");
	});
	test("rejects interleaved sequences and out-of-order chunks", () => {
		const a = chunks(big, "rpc-1");
		const b = chunks(big, "rpc-2");
		const interleaved = new ChunkDecoder();
		interleaved.push(a[0]);
		expect(() => interleaved.push(b[1])).toThrow("mismatch");
		const skipped = new ChunkDecoder();
		skipped.push(a[0]);
		expect(() => skipped.push(a[2])).toThrow("mismatch");
		expect(() => new ChunkDecoder().push(a[1])).toThrow("index 0");
	});
	test("validates metadata bounds", () => {
		const [first] = chunks(big);
		const bad = (patch: Record<string, unknown>) => () => new ChunkDecoder().push({ ...first, ...patch });
		expect(bad({ chunkId: "" })).toThrow("metadata");
		expect(bad({ count: 1 })).toThrow("metadata");
		expect(bad({ index: -1 })).toThrow("metadata");
		expect(bad({ byteLength: 10 })).toThrow("metadata");
		expect(bad({ byteLength: 65 * 1024 * 1024 })).toThrow("metadata");
		expect(bad({ count: 1.5 })).toThrow("metadata");
	});
	test("rejects non-canonical base64 and oversized payloads", () => {
		const [first] = chunks(big);
		expect(() => new ChunkDecoder().push({ ...first, data: "abc" })).toThrow("data");
		expect(() => new ChunkDecoder().push({ ...first, data: "" })).toThrow("data");
		const oversized = Buffer.alloc(CHUNK + 3).toString("base64");
		expect(() => new ChunkDecoder().push({ ...first, data: oversized })).toThrow("transport limit");
	});
	test("rejects a declared length that does not match the data", () => {
		const parts = chunks(big).map((part) => ({ ...part, byteLength: (part.byteLength as number) + 1 }));
		const decoder = new ChunkDecoder();
		expect(() => {
			for (const part of parts) decoder.push(part);
		}).toThrow("length mismatch");
	});
	test("rejects reassembled bytes that are not UTF-8 or not a JSON object", () => {
		const raw = Buffer.alloc(MAX_FRAME_BYTES + 10, 0x20);
		raw[5] = 0xff;
		const make = (bytes: Buffer) =>
			[0, 1, 2, 3, 4].map((index) => ({
				type: "rpc_chunk",
				chunkId: "x",
				index,
				count: 5,
				byteLength: bytes.byteLength,
				data: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString("base64"),
			}));
		const decode = (bytes: Buffer) => () => {
			const decoder = new ChunkDecoder();
			for (const part of make(bytes)) decoder.push(part);
		};
		expect(decode(raw)).toThrow("UTF-8");
		const array = Buffer.from(`[${" ".repeat(MAX_FRAME_BYTES + 8)}]`);
		expect(decode(array)).toThrow("object");
	});
});
