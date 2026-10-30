import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * The em dash (U+2014) is banned in written output. This used to `block` the
 * tool call, which threw away the whole streamed payload: a 300-line component
 * was regenerated from scratch over one character. Now the write lands and the
 * finding is appended to the tool result, so the fix is one targeted edit.
 *
 * It deliberately does NOT auto-swap the glyph. A hyphen is usually the wrong
 * punctuation; the rule wants the line reworded.
 *
 * `write` carries `content`; `edit` in hashline mode carries `input`, where only
 * `+` body rows are new text. Legacy `new_string` / `edits` shapes are still
 * handled so the hook keeps working if `edit.mode` changes.
 */

const EM_DASH = /\u2014/;

const TARGETS: Record<string, true> = {
  write: true,
  edit: true,
  multiedit: true,
  apply_patch: true
};

/** Hashline section header, e.g. `[src/lib/Foo.svelte#A1B2]`. */
const SECTION = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]$/;

type Finding = { label: string; line: number; snippet: string };

function getString(value: unknown, key: string): string {
  if (value && typeof value === "object" && key in value) {
    const candidate = Reflect.get(value, key);
    return typeof candidate === "string" ? candidate : "";
  }
  return "";
}

/** Hashline bodies only add text on `+` rows; everything else is addressing. */
function scanHashline(patch: string): Finding[] {
  const findings: Finding[] = [];
  let section = "patch";
  let row = 0;
  for (const line of patch.split("\n")) {
    const header = SECTION.exec(line);
    if (header?.[1]) {
      section = header[1];
      row = 0;
      continue;
    }
    if (!line.startsWith("+")) {
      continue;
    }
    row += 1;
    if (EM_DASH.test(line)) {
      findings.push({ label: section, line: row, snippet: line.slice(1).trim() });
    }
  }
  return findings;
}

function scanText(label: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    if (EM_DASH.test(line)) {
      findings.push({ label, line: index + 1, snippet: line.trim() });
    }
  });
  return findings;
}

function collect(toolName: string, input: unknown): Finding[] {
  const name = toolName.toLowerCase();

  if (name === "write") {
    const path = getString(input, "path");
    // xd:// device payloads are tool arguments, not prose destined for a file.
    if (path.includes("://")) {
      return [];
    }
    return scanText(path || "content", getString(input, "content"));
  }

  if (name === "edit" || name === "apply_patch") {
    const patch = getString(input, "input") || getString(input, "patch");
    if (patch) {
      return scanHashline(patch);
    }
    return scanText(getString(input, "file_path") || "new_string", getString(input, "new_string"));
  }

  if (name === "multiedit") {
    const raw = input && typeof input === "object" ? Reflect.get(input, "edits") : undefined;
    const edits = Array.isArray(raw) ? raw : [];
    return edits.flatMap((entry, i) => scanText(`edit ${i + 1}`, getString(entry, "new_string")));
  }

  return [];
}

export default function noEmDashExtension(pi: ExtensionAPI) {
  pi.setLabel("No em dash");

  pi.on("tool_result", async (event) => {
    if (event.isError || !TARGETS[event.toolName.toLowerCase()]) {
      return;
    }

    const findings = collect(event.toolName, event.input);
    if (findings.length === 0) {
      return;
    }

    const note = [
      "",
      `[no-em-dash] ${findings.length} em dash (U+2014) written. The file landed; fix it with a targeted edit now.`,
      "Reword the line rather than swapping the glyph: a hyphen is usually the wrong",
      "punctuation. Prefer a comma, colon, parentheses, or a reworded sentence.",
      ...findings.map((f) => `    ${f.label} +${f.line}: ${f.snippet}`)
    ].join("\n");

    return {
      content: [...event.content, { type: "text" as const, text: note }]
    };
  });
}
