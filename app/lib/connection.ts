/** Whether the app is online, and whether what's on screen is mail saved on this device. */
import { useSyncExternalStore } from "react";

/** When the last API answer came from this device's saved copy (ms), or null if it came live. */
let servedFromCache: number | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** apiFetch reports where each answer came from. */
export function noteResponseSource(res: Response): void {
	const saved = res.headers.get("x-cfw-offline");
	const next = saved === null ? null : Number(saved) || 0;
	if (next === servedFromCache) return;
	servedFromCache = next;
	emit();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	window.addEventListener("online", listener);
	window.addEventListener("offline", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("online", listener);
		window.removeEventListener("offline", listener);
	};
}

export interface ConnectionState {
	online: boolean;
	/** Set when what's on screen came from this device's saved mail: when it was saved. */
	savedAt: number | null;
}

let snapshot: ConnectionState = { online: true, savedAt: null };
function getSnapshot(): ConnectionState {
	const online = navigator.onLine;
	if (snapshot.online !== online || snapshot.savedAt !== servedFromCache) snapshot = { online, savedAt: servedFromCache };
	return snapshot;
}
const serverSnapshot: ConnectionState = { online: true, savedAt: null };

export function useConnection(): ConnectionState {
	return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}
