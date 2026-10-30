/**
 * The single icon registry. Nothing else imports @lucide/svelte. Render through lib/ui/Icon.svelte so sizes
 * come from the --icon-* tokens; icons inherit currentColor.
 */
import type { WindowKind } from "@romp/protocol";
import type { Component } from "svelte";
import type { LucideProps } from "@lucide/svelte";
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowDownToLine from "@lucide/svelte/icons/arrow-down-to-line";
import ArrowLeft from "@lucide/svelte/icons/arrow-left";
import ArrowRight from "@lucide/svelte/icons/arrow-right";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Bot from "@lucide/svelte/icons/bot";
import Brain from "@lucide/svelte/icons/brain";
import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import CircleDot from "@lucide/svelte/icons/circle-dot";
import CircleX from "@lucide/svelte/icons/circle-x";
import Clock from "@lucide/svelte/icons/clock";
import Command from "@lucide/svelte/icons/command";
import Copy from "@lucide/svelte/icons/copy";
import Ellipsis from "@lucide/svelte/icons/ellipsis";
import ExternalLink from "@lucide/svelte/icons/external-link";
import File from "@lucide/svelte/icons/file";
import FileCode from "@lucide/svelte/icons/file-code";
import FileImage from "@lucide/svelte/icons/file-image";
import FilePen from "@lucide/svelte/icons/file-pen";
import FilePlus from "@lucide/svelte/icons/file-plus";
import FileText from "@lucide/svelte/icons/file-text";
import Folder from "@lucide/svelte/icons/folder";
import FolderPlus from "@lucide/svelte/icons/folder-plus";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import GalleryHorizontalEnd from "@lucide/svelte/icons/gallery-horizontal-end";
import GitBranch from "@lucide/svelte/icons/git-branch";
import GitMerge from "@lucide/svelte/icons/git-merge";
import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
import Globe from "@lucide/svelte/icons/globe";
import GripVertical from "@lucide/svelte/icons/grip-vertical";
import House from "@lucide/svelte/icons/house";
import KeyboardOff from "@lucide/svelte/icons/keyboard-off";
import Layers from "@lucide/svelte/icons/layers";
import LayoutGrid from "@lucide/svelte/icons/layout-grid";
import LoaderCircle from "@lucide/svelte/icons/loader-circle";
import Pencil from "@lucide/svelte/icons/pencil";
import Plus from "@lucide/svelte/icons/plus";
import Rocket from "@lucide/svelte/icons/rocket";
import RotateCw from "@lucide/svelte/icons/rotate-cw";
import Search from "@lucide/svelte/icons/search";
import Square from "@lucide/svelte/icons/square";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import Trash2 from "@lucide/svelte/icons/trash-2";
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import Undo2 from "@lucide/svelte/icons/undo-2";
import Users from "@lucide/svelte/icons/users";
import WifiOff from "@lucide/svelte/icons/wifi-off";
import Wrench from "@lucide/svelte/icons/wrench";
import X from "@lucide/svelte/icons/x";

export type IconComponent = Component<LucideProps>;

export const Icons = {
	// Window kinds
	Terminal: SquareTerminal,
	Files: FolderTree,
	Editor: FileCode,
	Agent: Bot,
	Browser: Globe,
	Tasks: GitBranch,
	// UI
	Close: X,
	Add: Plus,
	Overview: Layers,
	ModeScroll: GalleryHorizontalEnd,
	ModeTile: LayoutGrid,
	Clients: Users,
	Spinner: LoaderCircle,
	Check,
	Success: CircleCheck,
	Fail: CircleX,
	Warn: TriangleAlert,
	Queued: Clock,
	Active: CircleDot,
	Ahead: ArrowUp,
	Behind: ArrowDown,
	Stop: Square,
	Send: ArrowUp,
	Thinking: Brain,
	Tool: Wrench,
	ToolEdit: FilePen,
	ToolRead: FileText,
	ToolWrite: FilePlus,
	ToolSearch: Search,
	Search,
	Folder,
	File,
	FileCode,
	FileImage,
	FolderPlus,
	FilePlus,
	More: Ellipsis,
	External: ExternalLink,
	Reload: RotateCw,
	ChevronRight,
	ChevronDown,
	ChevronUp,
	MoveLeft: ArrowLeft,
	MoveRight: ArrowRight,
	Trash: Trash2,
	Rename: Pencil,
	Undo: Undo2,
	LandPush: GitMerge,
	LandPr: GitPullRequest,
	Ship: Rocket,
	Offline: WifiOff,
	HideKeyboard: KeyboardOff,
	Copy,
	JumpLatest: ArrowDownToLine,
	Grip: GripVertical,
	Shortcuts: Command,
	Home: House,
} satisfies Record<string, IconComponent>;

export const KIND_ICON: Record<WindowKind, IconComponent> = {
	terminal: Icons.Terminal,
	files: Icons.Files,
	editor: Icons.Editor,
	agent: Icons.Agent,
	browser: Icons.Browser,
	tasks: Icons.Tasks,
};
