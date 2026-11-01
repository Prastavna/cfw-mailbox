import { useSyncExternalStore } from "react";

/** Whether a CSS media query matches; false during server rendering. */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(notify) => {
			const mql = window.matchMedia(query);
			mql.addEventListener("change", notify);
			return () => mql.removeEventListener("change", notify);
		},
		() => window.matchMedia(query).matches,
		() => false,
	);
}
