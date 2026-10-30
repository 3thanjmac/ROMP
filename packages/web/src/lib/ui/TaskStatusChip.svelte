<script module lang="ts">
	import type { TaskStatus } from "@romp/protocol";
	import { Icons, type IconComponent } from "../icons";

	export const TASK_STATUS: Record<TaskStatus, { label: string; icon: IconComponent; tone: string }> = {
		active: { label: "Active", icon: Icons.Active, tone: "task-active" },
		conflict: { label: "Conflict", icon: Icons.Warn, tone: "task-conflict" },
		queued: { label: "Queued", icon: Icons.Queued, tone: "task-queued" },
		landing: { label: "Landing", icon: Icons.Spinner, tone: "task-landing" },
		landed: { label: "Landed", icon: Icons.Success, tone: "task-landed" },
		failed: { label: "Failed", icon: Icons.Fail, tone: "task-failed" },
	};
</script>

<script lang="ts">
	import Chip from "./Chip.svelte";

	let { status }: { status: TaskStatus } = $props();
	const s = $derived(TASK_STATUS[status]);
</script>

<Chip tone={s.tone} icon={s.icon} spin={status === "landing"}>{s.label}</Chip>
