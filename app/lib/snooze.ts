/** Gmail's snooze presets, in the user's local time. */

export interface SnoozePreset {
	label: string;
	until: Date;
}

const at = (base: Date, days: number, hour: number) => {
	const d = new Date(base);
	d.setDate(d.getDate() + days);
	d.setHours(hour, 0, 0, 0);
	return d;
};

export function snoozePresets(now = new Date()): SnoozePreset[] {
	const presets: SnoozePreset[] = [];
	const day = now.getDay(); // 0 Sunday … 6 Saturday
	// "Later today" is 6 PM, offered until an hour before.
	if (now.getHours() < 17) presets.push({ label: "Later today", until: at(now, 0, 18) });
	presets.push({ label: "Tomorrow", until: at(now, 1, 8) });
	// "This weekend" is Saturday morning, offered Monday to Thursday.
	if (day >= 1 && day <= 4) presets.push({ label: "This weekend", until: at(now, 6 - day, 8) });
	// "Next week" is the coming Monday morning; on Sunday that's already "Tomorrow".
	if (day !== 0) presets.push({ label: "Next week", until: at(now, 8 - day, 8) });
	return presets;
}

export function formatSnoozeTime(ms: number, now = new Date()): string {
	const d = new Date(ms);
	const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const days = Math.round((at(d, 0, 0).getTime() - at(now, 0, 0).getTime()) / 86_400_000);
	if (days === 0) return `Today, ${time}`;
	if (days === 1) return `Tomorrow, ${time}`;
	if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** For "snoozed until …" sentences: "tomorrow, 8:00 AM". */
export function snoozeLabel(ms: number, now = new Date()): string {
	return formatSnoozeTime(ms, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
}

/** The time beside a preset in the menu: "Mon, 8:00 AM". */
export function presetTime(d: Date): string {
	return `${d.toLocaleDateString(undefined, { weekday: "short" })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
