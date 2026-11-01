import type { SeedAttachment } from "./seed";

/** Generated attachment contents, as data URLs (they work in sandboxed email iframes and downloads). */

const toDataUrl = (mime: string, text: string) => `data:${mime};base64,${btoa(unescape(encodeURIComponent(text)))}`;

/** A small, valid one-page PDF showing the given lines. */
export function pdf(lines: string[]): string {
	const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "-");
	const content = [
		"BT",
		"/F1 20 Tf 60 760 Td",
		`(${esc(lines[0] ?? "")}) Tj`,
		"/F1 12 Tf",
		...lines.slice(1).map((l) => `0 -22 Td (${esc(l)}) Tj`),
		"ET",
	].join("\n");
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return `data:application/pdf;base64,${btoa(out)}`;
}

/** A colourful placeholder picture, drawn on a canvas. */
export function png(label: string, seed: number): string {
	const canvas = document.createElement("canvas");
	canvas.width = 640;
	canvas.height = 400;
	const ctx = canvas.getContext("2d");
	if (!ctx) return "data:image/png;base64,";
	const hue = (seed * 47) % 360;
	const g = ctx.createLinearGradient(0, 0, 640, 400);
	g.addColorStop(0, `hsl(${hue} 80% 60%)`);
	g.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 45%)`);
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 640, 400);
	ctx.fillStyle = "rgba(255,255,255,0.18)";
	for (let i = 0; i < 6; i++) {
		ctx.beginPath();
		ctx.arc(80 + i * 110, 300 - ((i * 53 + seed * 31) % 160), 40 + ((i * 17) % 50), 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.fillStyle = "white";
	ctx.font = "600 34px system-ui, sans-serif";
	ctx.textAlign = "center";
	ctx.fillText(label, 320, 200);
	return canvas.toDataURL("image/png");
}

export function seedAttachmentFile(a: SeedAttachment, seed: number): { mimeType: string; dataUrl: string } {
	switch (a.kind) {
		case "pdf":
			return { mimeType: "application/pdf", dataUrl: pdf(a.lines ?? [a.filename]) };
		case "image":
			return { mimeType: "image/png", dataUrl: png(a.filename.replace(/\.\w+$/, ""), seed) };
		case "calendar":
			return {
				mimeType: "text/calendar",
				dataUrl: toDataUrl(
					"text/calendar",
					`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:${a.lines?.[0] ?? a.filename}\r\nDESCRIPTION:${a.lines?.slice(1).join(" ") ?? ""}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
				),
			};
		case "text":
			return { mimeType: "text/plain", dataUrl: toDataUrl("text/plain", (a.lines ?? []).join("\n")) };
	}
}

/** Approximate decoded size of a data URL. */
export function dataUrlSize(url: string): number {
	const comma = url.indexOf(",");
	return Math.floor(((url.length - comma - 1) * 3) / 4);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}
