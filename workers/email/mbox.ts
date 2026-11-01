/**
 * mboxrd: messages separated by "From " lines; any body line that starts with ">*From " gets one
 * more ">", so readers can tell it apart from a separator (and writers can undo it exactly).
 */

const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "
const GT = 0x3e;
const LF = 0x0a;

/** "From sender@example.com Sun Nov  1 19:38:14 2026" (asctime, UTC). */
export function fromLine(sender: string, date: number): string {
	const d = new Date(date);
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const pad = (n: number) => String(n).padStart(2, "0");
	const who = sender.replace(/\s/g, "") || "MAILER-DAEMON";
	return `From ${who} ${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}\n`;
}

/**
 * Whether `bytes[start..]` begins with ">*From ". `null` when the chunk ends before that's
 * known, so the caller holds those bytes back until more arrive.
 */
function startsQuotedFrom(bytes: Uint8Array, start: number): boolean | null {
	let i = start;
	while (i < bytes.length && bytes[i] === GT) i++;
	for (let k = 0; k < FROM.length; k++, i++) {
		if (i >= bytes.length) return null;
		if (bytes[i] !== FROM[k]) return false;
	}
	return true;
}

/** Escapes one message's bytes for mboxrd. Create one per message (each starts at a line start). */
export function mboxrdEscaper(): TransformStream<Uint8Array, Uint8Array> {
	let carry: Uint8Array | null = null; // undecided bytes at the start of a line
	let lastByte = LF;
	return new TransformStream({
		transform(chunk, controller) {
			let bytes = chunk;
			if (carry) {
				bytes = new Uint8Array(carry.length + chunk.length);
				bytes.set(carry);
				bytes.set(chunk, carry.length);
				carry = null;
			}
			if (!bytes.length) return;
			let out = 0; // start of bytes not yet enqueued
			let lineStart = lastByte === LF ? 0 : bytes.indexOf(LF) + 1 || bytes.length;
			while (lineStart < bytes.length) {
				const match = startsQuotedFrom(bytes, lineStart);
				if (match === null) {
					if (lineStart > out) controller.enqueue(bytes.subarray(out, lineStart));
					carry = bytes.slice(lineStart);
					lastByte = LF;
					return;
				}
				if (match) {
					if (lineStart > out) controller.enqueue(bytes.subarray(out, lineStart));
					controller.enqueue(new Uint8Array([GT]));
					out = lineStart;
				}
				const next = bytes.indexOf(LF, lineStart);
				if (next < 0) break;
				lineStart = next + 1;
			}
			if (out < bytes.length) controller.enqueue(bytes.subarray(out));
			lastByte = bytes[bytes.length - 1]!;
		},
		flush(controller) {
			// A final partial line that never completed ">*From " is passed through as is.
			if (carry?.length) {
				controller.enqueue(carry);
				lastByte = carry[carry.length - 1]!;
			}
			// Each message ends with a newline and a blank line before the next "From ".
			controller.enqueue(new TextEncoder().encode(lastByte === LF ? "\n" : "\n\n"));
		},
	});
}
