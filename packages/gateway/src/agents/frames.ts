import { isRecord } from "../util.ts";

/** OMP protocol v2 limits (oh-my-pi `modes/rpc/rpc-frame.ts`). */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CHUNK_PAYLOAD_BYTES = 256 * 1024;
const MAX_CHUNK_COUNT = Math.ceil(MAX_REASSEMBLED_BYTES / CHUNK_PAYLOAD_BYTES);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type RpcFrame = Record<string, unknown> & { type: string };

export class FrameError extends Error {}

/**
 * Splits a byte stream into newline-terminated lines decoded as strict UTF-8. Lines longer than the
 * physical frame limit are a protocol violation.
 */
export class LineSplitter {
	private parts: Uint8Array[] = [];
	private size = 0;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });

	push(bytes: Uint8Array): string[] {
		const lines: string[] = [];
		let start = 0;
		for (;;) {
			const newline = bytes.indexOf(0x0a, start);
			if (newline < 0) break;
			this.append(bytes.subarray(start, newline));
			const line = this.take();
			if (line.trim() !== "") lines.push(line);
			start = newline + 1;
		}
		if (start < bytes.length) this.append(bytes.subarray(start));
		return lines;
	}

	private append(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		this.size += bytes.length;
		if (this.size >= MAX_FRAME_BYTES) throw new FrameError("RPC frame exceeds the 1 MiB transport limit");
		// The source buffer is reused by the stream reader, so keep a copy.
		this.parts.push(bytes.slice());
	}

	private take(): string {
		const joined = this.parts.length === 1 ? (this.parts[0] ?? new Uint8Array()) : Buffer.concat(this.parts);
		this.parts = [];
		this.size = 0;
		try {
			return this.decoder.decode(joined);
		} catch {
			throw new FrameError("RPC frame is not valid UTF-8");
		}
	}
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Buffer[];
	received: number;
}

/**
 * Reassembles protocol v2 `rpc_chunk` sequences into logical frames, with the validation the OMP RPC
 * docs require: metadata bounds, strict base64, no interleaving or interruption, declared length,
 * reassembly limit, strict UTF-8 and a JSON object result.
 */
export class ChunkDecoder {
	private pending: PendingChunks | null = null;

	/** Returns the logical frame, or null while a chunk sequence is incomplete. */
	push(value: unknown): RpcFrame | null {
		if (!isRecord(value)) throw new FrameError("RPC frame must be a JSON object");
		if (value.type !== "rpc_chunk") {
			if (this.pending) throw new FrameError("rpc_chunk sequence interrupted");
			return asFrame(value);
		}
		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			count > MAX_CHUNK_COUNT ||
			index >= count ||
			byteLength < MAX_FRAME_BYTES ||
			byteLength > MAX_REASSEMBLED_BYTES
		) {
			throw new FrameError("invalid rpc_chunk metadata");
		}
		const bytes = decodeBase64(value.data);
		if (bytes.byteLength > CHUNK_PAYLOAD_BYTES) throw new FrameError("rpc_chunk payload exceeds the transport limit");

		if (!this.pending) {
			if (index !== 0) throw new FrameError("rpc_chunk sequence must start at index 0");
			this.pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], received: 0 };
		}
		const pending = this.pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new FrameError("rpc_chunk sequence mismatch");
		}
		pending.chunks.push(bytes);
		pending.received += bytes.byteLength;
		pending.nextIndex++;
		if (pending.received > pending.byteLength) throw new FrameError("rpc_chunk sequence exceeds its declared length");
		if (pending.nextIndex < pending.count) return null;
		this.pending = null;
		if (pending.received !== pending.byteLength) throw new FrameError("rpc_chunk sequence length mismatch");

		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		} catch {
			throw new FrameError("reassembled RPC frame is not valid UTF-8");
		}
		return asFrame(parseJson(text));
	}
}

function decodeBase64(data: unknown): Buffer {
	if (typeof data !== "string" || data.length === 0 || !BASE64.test(data)) {
		throw new FrameError("invalid rpc_chunk data");
	}
	return Buffer.from(data, "base64");
}

export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new FrameError("RPC frame is not valid JSON");
	}
}

function asFrame(value: unknown): RpcFrame {
	if (!isRecord(value) || typeof value.type !== "string") throw new FrameError("RPC frame must be an object with a type");
	return value as RpcFrame;
}
