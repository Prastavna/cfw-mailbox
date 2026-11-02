import { useRef, useState } from "react";

/** How far (as a share of the row's width) a swipe must go to count. */
const THRESHOLD = 0.35;

/**
 * A horizontal touch swipe on a list row, as in Gmail's app. Vertical drags stay scrolls
 * (give the row `touch-action: pan-y`); a swipe past the threshold either way calls `onSwipe`.
 */
export function useSwipe(enabled: boolean, onSwipe: () => void) {
	const [offset, setOffset] = useState(0);
	const [leaving, setLeaving] = useState(false);
	const drag = useRef<{ x: number; y: number; axis: "x" | "y" | null; width: number } | null>(null);
	const swiped = useRef(false);

	const reset = () => {
		drag.current = null;
		setOffset(0);
	};

	const handlers = enabled
		? {
				onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
					if (e.pointerType !== "touch" || leaving) return;
					swiped.current = false;
					drag.current = { x: e.clientX, y: e.clientY, axis: null, width: e.currentTarget.offsetWidth || 1 };
				},
				onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
					const d = drag.current;
					if (!d) return;
					const dx = e.clientX - d.x;
					const dy = e.clientY - d.y;
					if (!d.axis) {
						if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
							d.axis = "x";
							try {
								e.currentTarget.setPointerCapture(e.pointerId);
							} catch {
								// The pointer is already gone; the drag still works without capture.
							}
						} else if (Math.abs(dy) > 10) {
							drag.current = null;
							return;
						} else return;
					}
					setOffset(dx);
				},
				onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
					const d = drag.current;
					if (!d || d.axis !== "x") return reset();
					swiped.current = true;
					const dx = e.clientX - d.x;
					drag.current = null;
					if (Math.abs(dx) < d.width * THRESHOLD) return setOffset(0);
					// Slide the row out, then act.
					setLeaving(true);
					setOffset(Math.sign(dx) * d.width);
					setTimeout(() => {
						onSwipe();
						setLeaving(false);
						setOffset(0);
					}, 180);
				},
				onPointerCancel: reset,
				// A swipe ends with a click on whatever was under the finger; don't open the conversation.
				onClickCapture: (e: React.MouseEvent) => {
					if (!swiped.current) return;
					swiped.current = false;
					e.preventDefault();
					e.stopPropagation();
				},
			}
		: {};

	return { offset, dragging: drag.current?.axis === "x", leaving, handlers };
}
