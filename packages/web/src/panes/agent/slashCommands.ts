/**
 * Slash-command completion for the agent composer: which OMP commands (or a command's subcommands) the current text
 * can still complete to. Pure, so the matching rules are testable without the DOM.
 */
import type { AgentCommand } from "../../lib/agent/types";

type Subcommand = NonNullable<AgentCommand["subcommands"]>[number];

export interface SlashSuggestion {
	key: string;
	/** The canonical command (also the parent of a subcommand suggestion). */
	command: AgentCommand;
	subcommand?: Subcommand;
	/** Display name: the command name, or the subcommand name for subcommand rows. */
	name: string;
	description: string | null;
	/** Subcommands inherit their parent's source. */
	source: string;
	/** Argument hint, command rows only. */
	hint?: string;
	/** The whole composer text after completing: canonical name(s) plus one trailing space. */
	insertText: string;
}

export interface SlashCompletion {
	/** A completion is available; false means the menu stays closed. */
	open: boolean;
	items: SlashSuggestion[];
}

const CLOSED: SlashCompletion = { open: false, items: [] };

export function slashCompletion(text: string, commands: AgentCommand[]): SlashCompletion {
	if (!text.startsWith("/") || /[\r\n]/.test(text)) return CLOSED;
	const body = text.slice(1);
	const space = body.search(/\s/);
	return space < 0 ? commandLevel(body, commands) : subcommandLevel(body.slice(0, space), body.slice(space), commands);
}

function commandLevel(token: string, commands: AgentCommand[]): SlashCompletion {
	const query = token.toLowerCase();
	const ranked: Array<{ command: AgentCommand; rank: number; index: number }> = [];
	commands.forEach((command, index) => {
		const name = command.name.toLowerCase();
		const aliases = (command.aliases ?? []).map(a => a.toLowerCase());
		const rank =
			name === query || aliases.includes(query)
				? 0
				: name.startsWith(query)
					? 1
					: aliases.some(a => a.startsWith(query))
						? 2
						: -1;
		if (rank >= 0) ranked.push({ command, rank, index });
	});
	if (ranked.length === 0) return CLOSED;
	ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
	// Typing a whole terminal command with nothing longer left to complete: Enter sends it as is.
	const only = ranked.length === 1 ? ranked[0]! : null;
	if (only && only.rank === 0 && !only.command.subcommands?.length) return CLOSED;
	return {
		open: true,
		items: ranked.map(({ command, index }) => ({
			key: `${index}`,
			command,
			name: command.name,
			description: command.description ?? null,
			source: command.source,
			hint: command.input?.hint,
			insertText: `/${command.name} `,
		})),
	};
}

function subcommandLevel(head: string, rest: string, commands: AgentCommand[]): SlashCompletion {
	const query = head.toLowerCase();
	const index = commands.findIndex(
		c => c.name.toLowerCase() === query || (c.aliases ?? []).some(a => a.toLowerCase() === query),
	);
	const command = commands[index];
	const subcommands = command?.subcommands ?? [];
	if (!command || subcommands.length === 0) return CLOSED;
	const partial = rest.replace(/^\s+/, "");
	if (/\s/.test(partial)) return CLOSED;
	const lower = partial.toLowerCase();
	const exact = subcommands.filter(s => s.name.toLowerCase() === lower);
	const prefix = subcommands.filter(s => s.name.toLowerCase() !== lower && s.name.toLowerCase().startsWith(lower));
	const matches = [...exact, ...prefix];
	// Subcommands are the last level, so an exact one with nothing longer is complete.
	if (matches.length === 0 || (exact.length > 0 && prefix.length === 0)) return CLOSED;
	return {
		open: true,
		items: matches.map(subcommand => ({
			key: `${index} ${subcommand.name}`,
			command,
			subcommand,
			name: subcommand.name,
			description: subcommand.description ?? null,
			source: command.source,
			insertText: `/${command.name} ${subcommand.name} `,
		})),
	};
}
