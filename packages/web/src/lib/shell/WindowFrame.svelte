<script lang="ts">
	import type { WindowState } from "@romp/protocol";
	import { onDestroy } from "svelte";
	import { type PaneContext, PaneStatus, paneStatuses, registerFocusHandler } from "./pane.svelte";
	import PaneHost from "./PaneHost.svelte";
	import { displayTitle, shell } from "./shell.svelte";
	import TitleBar from "./TitleBar.svelte";

	interface Props {
		win: WindowState;
		focused: boolean;
		visible: boolean;
		showWidth: boolean;
		/** Phone carousel column: no border or radius. */
		bare: boolean;
	}

	let { win, focused, visible, showWidth, bare }: Props = $props();

	const status = new PaneStatus();
	// svelte-ignore state_referenced_locally
	const id = win.id;
	paneStatuses.set(id, status);
	onDestroy(() => {
		if (paneStatuses.get(id) === status) paneStatuses.delete(id);
	});

	const pane: PaneContext = {
		id,
		get focused() {
			return focused;
		},
		get visible() {
			return visible;
		},
		status,
		setProps: (patch) => shell.setProps(id, patch),
		onFocusRequest: (fn) => registerFocusHandler(id, fn),
		open: (spec) => shell.open(spec, { after: id }),
		close: () => shell.close(id),
	};
</script>

<section
	class="frame"
	class:focused
	class:bare
	data-kind={win.kind}
	data-window={id}
	tabindex="-1"
	aria-label={displayTitle(win)}
	onpointerdowncapture={() => shell.focus(id)}
>
	<TitleBar {win} {status} {focused} {showWidth} />
	<div class="body">
		<PaneHost {win} {pane} />
	</div>
</section>

<style>
	.frame {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-width: 0;
		background: var(--surface-1);
		border: var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
		position: relative;
		z-index: var(--z-pane);
		outline: none;
		transition: border-color var(--dur);
		&.focused {
			border-color: var(--accent);
			z-index: var(--z-pane-focused);
		}
		&.bare {
			border: 0;
			border-radius: 0;
		}
	}
	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
</style>
