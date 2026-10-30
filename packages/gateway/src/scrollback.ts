const CHUNK_TARGET = 16 * 1024;

/**
 * Terminal scrollback: the most recent `limit` bytes of PTY output, kept as decoded text. Small writes are
 * coalesced into ~16 KiB chunks so a stream of keystroke echoes does not create millions of entries.
 */
export class Scrollback {
	private chunks: string[] = [];
	private sizes: number[] = [];
	private total = 0;
	private truncated = false;

	constructor(private readonly limit: number) {}

	push(text: string, bytes: number): void {
		const last = this.chunks.length - 1;
		if (last >= 0 && (this.sizes[last] ?? 0) < CHUNK_TARGET) {
			this.chunks[last] += text;
			this.sizes[last] = (this.sizes[last] ?? 0) + bytes;
		} else {
			this.chunks.push(text);
			this.sizes.push(bytes);
		}
		this.total += bytes;
		while (this.total > this.limit && this.chunks.length > 1) {
			this.total -= this.sizes.shift() ?? 0;
			this.chunks.shift();
			this.truncated = true;
		}
		const first = this.chunks[0];
		if (this.total > this.limit && first !== undefined) {
			// One chunk larger than the whole buffer: keep its tail.
			const keep = Math.floor(first.length * (this.limit / this.total));
			this.chunks[0] = first.slice(first.length - keep);
			this.sizes[0] = this.limit;
			this.total = this.limit;
			this.truncated = true;
		}
	}

	/** The buffered text. After truncation it starts at a line boundary so replay does not begin mid-sequence. */
	text(): string {
		const text = this.chunks.join("");
		if (!this.truncated) return text;
		const newline = text.indexOf("\n");
		return newline >= 0 && newline < 4096 ? text.slice(newline + 1) : text;
	}
}
