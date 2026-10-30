<script lang="ts">
	import type { FsEntry } from "@romp/protocol";
	import { formatSize, relativeTime } from "../../lib/format";
	import { Icons } from "../../lib/icons";
	import Icon from "../../lib/ui/Icon.svelte";
	import IconButton from "../../lib/ui/IconButton.svelte";
	import Menu from "../../lib/ui/Menu.svelte";
	import MenuItem from "../../lib/ui/MenuItem.svelte";
	import { entryIcon } from "./fileKind";

	interface Props {
		entry: FsEntry;
		now: number;
		onopen: () => void;
		onrename: () => void;
		ontrash: () => void;
	}

	let { entry, now, onopen, onrename, ontrash }: Props = $props();
</script>

<li class="row">
	<button class="main" onclick={onopen}>
		<Icon icon={entryIcon(entry)} />
		<span class="name truncate">{entry.name}</span>
	</button>
	<span class="size meta tabular">{entry.kind === "dir" ? "" : formatSize(entry.size)}</span>
	<span class="age meta tabular">{relativeTime(entry.mtimeMs, now)}</span>
	<span class="more">
		<Menu label="File actions" placement="bottom-end">
			{#snippet trigger(props)}
				<IconButton {...props} size="sm" label="File actions" icon={Icons.More} />
			{/snippet}
			<MenuItem icon={Icons.Rename} onselect={onrename}>Rename</MenuItem>
			<MenuItem icon={Icons.Trash} danger onselect={ontrash}>Move to trash</MenuItem>
		</Menu>
	</span>
</li>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-height: var(--row-h);
		padding-inline: var(--sp-1) var(--sp-2);
		list-style: none;
		transition: background var(--dur-fast);
		&:hover {
			background: var(--surface-3);
		}
	}
	.main {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 1;
		min-width: 0;
		align-self: stretch;
		padding-inline: var(--sp-2);
		color: var(--fg);
		> :global(.icon) {
			color: var(--fg-muted);
		}
	}
	.size {
		width: 4.5em;
		text-align: end;
		flex: none;
	}
	.age {
		width: 3em;
		text-align: end;
		flex: none;
	}
	.more {
		display: inline-flex;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.row:hover .more,
	.row:focus-within .more,
	.more:has(:global([aria-expanded="true"])) {
		opacity: 1;
	}
	@media (pointer: coarse) {
		.more {
			opacity: 1;
		}
		.size {
			display: none;
		}
	}
</style>
