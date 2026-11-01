import { useEffect, useRef, useSyncExternalStore } from "react";

/** Gmail-style single-key shortcuts. Keys are `KeyboardEvent.key` values; "g i" is a two-key sequence. */
export type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

interface Layer {
	map: { current: ShortcutMap };
	priority: number;
	order: number;
}

const layers: Layer[] = [];
let order = 0;
let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

// ---- On/off, per browser -------------------------------------------------------

const ENABLED_KEY = "cfw-mailbox:shortcuts";
const listeners = new Set<() => void>();
let enabledCache: boolean | null = null;

function readEnabled(): boolean {
	if (enabledCache === null) {
		try {
			enabledCache = localStorage.getItem(ENABLED_KEY) !== "off";
		} catch {
			enabledCache = true;
		}
	}
	return enabledCache;
}

export function setShortcutsEnabled(on: boolean) {
	enabledCache = on;
	try {
		localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
	} catch {
		// Remembered for this page only.
	}
	for (const l of listeners) l();
}

export function useShortcutsEnabled(): boolean {
	return useSyncExternalStore(
		(cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		readEnabled,
		() => true,
	);
}

// ---- Dispatch ------------------------------------------------------------------

/** Keys that still work with shortcuts turned off. */
const ALWAYS = new Set(["?"]);

const OVERLAYS = '[role="menu"], [role="listbox"], [data-slot="dialog-content"], [data-slot="popover-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"]';

/** Whether a keypress belongs to whatever has focus rather than to the shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	if (target instanceof HTMLElement && target.isContentEditable) return true;
	return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

function find(key: string): ((e: KeyboardEvent) => void) | undefined {
	const sorted = [...layers].sort((a, b) => b.priority - a.priority || b.order - a.order);
	for (const layer of sorted) {
		const fn = layer.map.current[key];
		if (fn) return fn;
	}
	return undefined;
}

function hasSequence(prefix: string): boolean {
	return layers.some((l) => Object.keys(l.map.current).some((k) => k.startsWith(`${prefix} `)));
}

function onKeyDown(e: KeyboardEvent) {
	if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
	if (isTypingTarget(e.target)) return;
	if (document.querySelector(OVERLAYS)) return;
	// Enter on a focused button or link should click it, not open the list cursor.
	if (e.key === "Enter" && e.target instanceof Element && e.target.closest("button, a, [role=button], [role=checkbox]")) return;

	let key = e.key;
	if (pending) {
		key = `${pending} ${e.key}`;
		pending = null;
		clearTimeout(pendingTimer);
	} else if (hasSequence(e.key) && !find(e.key)) {
		if (!readEnabled()) return;
		pending = e.key;
		pendingTimer = setTimeout(() => (pending = null), 1500);
		e.preventDefault();
		return;
	}
	if (!readEnabled() && !ALWAYS.has(key)) return;
	const fn = find(key);
	if (!fn) return;
	e.preventDefault();
	fn(e);
}

/**
 * Registers shortcuts while the component is mounted. Higher priority wins, then the most
 * recently mounted: the mailbox frame uses 0, the list or conversation on screen uses 1.
 */
export function useShortcuts(map: ShortcutMap, priority = 0) {
	const ref = useRef(map);
	ref.current = map;
	useEffect(() => {
		const layer: Layer = { map: ref, priority, order: order++ };
		if (layers.length === 0) document.addEventListener("keydown", onKeyDown);
		layers.push(layer);
		return () => {
			layers.splice(layers.indexOf(layer), 1);
			if (layers.length === 0) document.removeEventListener("keydown", onKeyDown);
		};
	}, [priority]);
}

/** What the help dialog lists. */
export const SHORTCUT_HELP: { section: string; items: [keys: string, description: string][] }[] = [
	{
		section: "Jumping",
		items: [
			["g then i", "Go to Inbox"],
			["g then s", "Go to Starred"],
			["g then t", "Go to Sent"],
			["g then d", "Go to Drafts"],
			["g then a", "Go to All Mail"],
		],
	},
	{
		section: "Navigation",
		items: [
			["j / k", "Older / newer conversation"],
			["o or Enter", "Open conversation"],
			["u", "Back to the list"],
			["/", "Search mail"],
			["?", "Show keyboard shortcuts"],
		],
	},
	{
		section: "Actions",
		items: [
			["c", "Compose"],
			["r", "Reply"],
			["a", "Reply all"],
			["f", "Forward"],
			["x", "Select conversation"],
			["s", "Star or unstar"],
			["e", "Archive"],
			["#", "Delete"],
			["!", "Report spam"],
			["b", "Snooze"],
			["Shift + i", "Mark as read"],
			["Shift + u", "Mark as unread"],
		],
	},
];

/** The conversation last opened, so the list cursor returns to it ("u" from a conversation). */
export const listCursor = { lastThreadId: null as string | null };
