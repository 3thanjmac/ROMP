import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, locateConfig } from "./config.ts";
import { writeFileAtomic } from "./util.ts";

const MIN_LENGTH = 8;
const USAGE = "usage: romp-gateway passwd [--config <path>]";

/**
 * `romp-gateway passwd`: sets the password for signing in over the LAN. It is stored as an argon2id hash in
 * `password` next to the gateway config; the running gateway reads it on each sign-in, and changing it signs
 * out every LAN session. Reads the password from the terminal, or the first line of stdin when piped.
 */
export async function passwd(argv: readonly string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(USAGE);
		return 0;
	}
	let file: string;
	try {
		file = join(dirname(locateConfig(argv, process.env, homedir()).path), "password");
	} catch (err) {
		if (!(err instanceof ConfigError)) throw err;
		console.error(`romp-gateway passwd: ${err.message}`);
		return 2;
	}
	let password: string;
	if (process.stdin.isTTY) {
		password = await promptHidden("New password: ");
		if ((await promptHidden("Repeat password: ")) !== password) {
			console.error("romp-gateway passwd: the passwords do not match");
			return 1;
		}
	} else {
		password = (await Bun.stdin.text()).split(/\r?\n/)[0] ?? "";
	}
	if (password.length < MIN_LENGTH) {
		console.error(`romp-gateway passwd: use at least ${MIN_LENGTH} characters`);
		return 1;
	}
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	await writeFileAtomic(file, `${await Bun.password.hash(password, "argon2id")}\n`, 0o600);
	console.log(`Password saved to ${file}. Every device signed in over the LAN has to sign in again.`);
	return 0;
}

/** Reads one line from the terminal without echoing it. */
function promptHidden(prompt: string): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const stdin = process.stdin;
	let value = "";
	const onData = (chunk: Buffer) => {
		for (const char of chunk.toString("utf8")) {
			if (char === "\r" || char === "\n") {
				finish();
				resolve(value);
				return;
			}
			if (char === "\u0003") {
				finish();
				process.exit(130);
			}
			if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
			else if (char >= " ") value += char;
		}
	};
	const finish = () => {
		stdin.off("data", onData);
		stdin.setRawMode(false);
		stdin.pause();
		process.stdout.write("\n");
	};
	process.stdout.write(prompt);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.on("data", onData);
	return promise;
}
