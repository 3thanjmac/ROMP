import { projectListeners, projectRoot } from "../bin/lib/system.mjs";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ESCAPE_HATCH = "dev-server-ok";

const START_PATTERNS: RegExp[] = [
  /\b(?:pnpm|pnpx|npm|npx|yarn|bun|bunx|deno)\s+(?:run\s+|exec\s+)?(?:dev|start|serve|preview|watch)(?::[\w.-]+)?(?![\w:.-])/,
  /\b(?:vite|next|nuxt|astro|remix|nodemon|wrangler|webpack-dev-server|parcel|turbo|ng|sst|svelte-kit)\b[^\n]*?(?:\b(?:dev|serve|start|preview)\b|--watch)/,
  /\b(?:uvicorn|gunicorn|flask\s+run|rails\s+s(?:erver)?\b|mix\s+phx\.server|php\s+-S|python[\d.]*\s+-m\s+http\.server)/
];

const HELP_PATTERN = /(?:^|\s)(?:-h|--help|--version)(?:\s|$)/;

const DEV_PROCESS =
  /\sdev(?:\s|$)|\bvite\b|\bnext-server\b|\bnuxt\b|\bastro\b|\bremix\b|webpack|nodemon|wrangler|workerd|parcel|\bsvelte-kit\b|uvicorn|gunicorn|http\.server|\brails\b/;

const COMMON_DEV_PORTS: Record<number, true> = {
  1420: true,
  3000: true,
  3001: true,
  3002: true,
  3003: true,
  4000: true,
  4173: true,
  4200: true,
  4321: true,
  5000: true,
  5173: true,
  5174: true,
  5175: true,
  5176: true,
  5183: true,
  7357: true,
  8000: true,
  8001: true,
  8080: true,
  8081: true,
  8090: true,
  8100: true,
  8180: true,
  8787: true,
  8788: true,
  9000: true
};

function commandText(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const bag = input as Record<string, unknown>;
  const name = toolName.toLowerCase();

  if (name === "bash") {
    return typeof bag.command === "string" ? bag.command : "";
  }
  if (name === "hub") {
    if (bag.op !== "start") {
      return "";
    }
    const args = Array.isArray(bag.args) ? bag.args.filter((a) => typeof a === "string") : [];
    return [typeof bag.application === "string" ? bag.application : "", ...args].join(" ");
  }
  if (name === "eval") {
    return typeof bag.code === "string" ? bag.code : "";
  }
  return "";
}

function startsDevServer(text: string): boolean {
  if (!text || text.includes(ESCAPE_HATCH) || HELP_PATTERN.test(text)) {
    return false;
  }
  return START_PATTERNS.some((pattern) => pattern.test(text));
}

export default function devServerGuard(pi: ExtensionAPI) {
  pi.setLabel("Dev server guard");

  pi.on("tool_call", async (event) => {
    const text = commandText(event.toolName, event.input);
    if (!startsDevServer(text)) {
      return;
    }

    const root = projectRoot();
    const running = projectListeners(root).filter((listener) => DEV_PROCESS.test(listener.cmd));
    if (running.length === 0) {
      return;
    }

    const primary = running.filter((l) => COMMON_DEV_PORTS[l.port]);
    const shown = primary.length > 0 ? primary : running.slice(0, 3);
    const urls = [...new Set(primary.map((l) => l.port))].sort((a, b) => a - b);
    const lines = [
      "[dev-server-guard] blocked: this project already has a dev server running.",
      "",
      `    ${text.trim()}`,
      "",
      "Already listening:"
    ];

    for (const listener of shown) {
      const cmd = listener.cmd.replaceAll(/[^\s"]*[\\/]node_modules[\\/]/g, "");
      lines.push(`    :${listener.port}  pid ${listener.pid}  ${cmd.length > 100 ? `${cmd.slice(0, 100)}...` : cmd}`);
    }

    lines.push("");
    lines.push(
      urls.length > 0
        ? `Use the running server: ${urls.map((p) => `http://localhost:${p}`).join(", ")}.`
        : "Use the running server (its HTTP port is one of the ports above)."
    );
    lines.push(
      "The user keeps a dev server up permanently outside this session, so a second one",
      "double-compiles, fights over the port, and its logs are not the ones being watched.",
      "If the running server is broken, tell the user instead of starting a rival copy.",
      `Genuinely need a separate instance (different port, isolated build)? Say why, then re-run with "${ESCAPE_HATCH}" in the command.`
    );

    return { block: true, reason: lines.join("\n") };
  });
}
