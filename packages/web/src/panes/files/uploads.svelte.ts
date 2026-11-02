/** Files pane upload queue: two uploads at a time, with conflict and error rows the user resolves. */
import { MAX_UPLOAD_BYTES } from "@romp/protocol";
import { api, ApiFailure, errorMessage } from "../../lib/api";
import { formatSize, uid } from "../../lib/format";
import { keepBothName } from "./uploadName";

export type UploadStatus = "queued" | "uploading" | "conflict" | "error";

export interface Upload {
	id: string;
	file: File;
	/** Target directory, captured when the file was picked or dropped. */
	dir: string;
	/** Name the file lands under; differs from file.name after "Keep both". */
	name: string;
	sent: number;
	total: number;
	status: UploadStatus;
	error: string | null;
	/** False when retrying cannot help (the file is over the size limit). */
	retryable: boolean;
	controller: AbortController | null;
	/** Send with overwrite=1, after "Replace". */
	overwrite: boolean;
	/** The n in `name (n).ext` after "Keep both"; another 409 advances it. 0 until then. */
	suffix: number;
}

export interface UploadHooks {
	/** Names already in `dir`, as far as the pane knows. */
	existing(dir: string): Iterable<string>;
	/** One file landed in `dir`. */
	uploaded(dir: string): void;
	/** Nothing is queued or uploading any more; `count` files landed since the last call, `name` last. */
	finished(count: number, name: string): void;
}

const CONCURRENCY = 2;

export class UploadQueue {
	items: Upload[] = $state([]);
	#hooks: UploadHooks;
	#landed = 0;
	#lastName = "";
	#closed = false;

	constructor(hooks: UploadHooks) {
		this.#hooks = hooks;
	}

	add(files: Iterable<File>, dir: string): void {
		for (const file of files) {
			const tooLarge = file.size > MAX_UPLOAD_BYTES;
			this.items.push({
				id: uid(),
				file,
				dir,
				name: file.name,
				sent: 0,
				total: file.size,
				status: tooLarge ? "error" : "queued",
				error: tooLarge ? `Too large: the limit is ${formatSize(MAX_UPLOAD_BYTES)}` : null,
				retryable: !tooLarge,
				controller: null,
				overwrite: false,
				suffix: 0,
			});
		}
		this.#pump();
	}

	/** Aborts a running upload (its row goes away when the request settles) or drops a waiting one. */
	cancel(id: string): void {
		const item = this.#get(id);
		if (item?.controller) item.controller.abort();
		else this.dismiss(id);
	}

	replace(id: string): void {
		const item = this.#get(id);
		if (!item) return;
		item.overwrite = true;
		this.#requeue(item);
	}

	keepBoth(id: string): void {
		const item = this.#get(id);
		if (!item) return;
		this.#renumber(item);
		this.#requeue(item);
	}

	retry(id: string): void {
		const item = this.#get(id);
		if (item?.retryable) this.#requeue(item);
	}

	/** Skip (conflict) and Dismiss (error). */
	dismiss(id: string): void {
		const i = this.items.findIndex((item) => item.id === id);
		if (i >= 0) this.items.splice(i, 1);
	}

	/** The pane is going away: abort everything and stay quiet about it. */
	abortAll(): void {
		this.#closed = true;
		for (const item of this.items) item.controller?.abort();
		this.items = [];
	}

	#get(id: string): Upload | undefined {
		return this.items.find((item) => item.id === id);
	}

	#requeue(item: Upload): void {
		item.status = "queued";
		item.error = null;
		item.sent = 0;
		this.#pump();
	}

	/** Next free `name (n).ext`, skipping names in the folder and names other uploads to it will take. */
	#renumber(item: Upload): void {
		const taken = new Set(this.#hooks.existing(item.dir));
		for (const other of this.items) if (other !== item && other.dir === item.dir) taken.add(other.name);
		const next = keepBothName(item.file.name, taken, item.suffix ? item.suffix + 1 : 2);
		item.name = next.name;
		item.suffix = next.n;
		item.overwrite = false;
	}

	#pump(): void {
		if (this.#closed) return;
		let active = this.items.filter((item) => item.status === "uploading").length;
		for (const item of this.items) {
			if (active >= CONCURRENCY) break;
			if (item.status !== "queued") continue;
			active++;
			void this.#run(item);
		}
		if (active === 0 && this.#landed > 0) {
			this.#hooks.finished(this.#landed, this.#lastName);
			this.#landed = 0;
		}
	}

	async #run(item: Upload): Promise<void> {
		const controller = new AbortController();
		item.status = "uploading";
		item.controller = controller;
		item.sent = 0;
		try {
			await api.fs.upload(item.dir, item.file, item.name, item.overwrite, {
				signal: controller.signal,
				onprogress: (sent, total) => {
					item.sent = sent;
					item.total = total;
				},
			});
			this.dismiss(item.id);
			this.#landed++;
			this.#lastName = item.name;
			this.#hooks.uploaded(item.dir);
		} catch (err) {
			item.controller = null;
			if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
				this.dismiss(item.id);
			} else if (err instanceof ApiFailure && err.status === 409 && err.code === "conflict") {
				if (item.suffix) {
					// The "Keep both" name was taken in the meantime: try the next number.
					this.#renumber(item);
					item.status = "queued";
				} else {
					item.status = "conflict";
					item.error = `A file named “${item.name}” already exists`;
				}
			} else {
				item.status = "error";
				item.error = errorMessage(err);
			}
		}
		this.#pump();
	}
}
