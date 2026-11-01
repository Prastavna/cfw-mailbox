import type { ExportItem } from "../mailbox/MailboxDO";
import { buildMime } from "./mime";
import { fromLine, mboxrdEscaper } from "./mbox";

interface ExportSource {
	exportPage(cursor: number, limit?: number): Promise<{ items: ExportItem[]; nextCursor: number | null }> | { items: ExportItem[]; nextCursor: number | null };
}

const encoder = new TextEncoder();

/** The message's bytes: the raw copy from R2, or a rebuilt one for mail sent from here. */
async function messageBytes(bucket: R2Bucket, item: ExportItem): Promise<ReadableStream<Uint8Array>> {
	if (item.rawKey) {
		const object = await bucket.get(item.rawKey);
		if (object) return object.body;
	}
	const { htmlKey, attachments, ...source } = item.source;
	const html = source.html ?? (htmlKey ? ((await (await bucket.get(htmlKey))?.text()) ?? null) : null);
	const loaded = await Promise.all(
		attachments.map(async ({ r2Key, ...a }) => {
			const object = await bucket.get(r2Key);
			return object ? { ...a, content: new Uint8Array(await object.arrayBuffer()) } : null;
		}),
	);
	const bytes = buildMime({ ...source, html, attachments: loaded.filter((a) => a !== null) });
	return new Blob([bytes]).stream();
}

/**
 * Streams the whole mailbox as an mboxrd file, one message at a time, so memory use stays flat.
 * Each message gets an `X-Mailbox-Labels` header (like Gmail's `X-Gmail-Labels`).
 */
export function exportMbox(bucket: R2Bucket, mailbox: ExportSource): ReadableStream<Uint8Array> {
	let cursor: number | null = 0;
	let queue: ExportItem[] = [];
	let current: ReadableStreamDefaultReader<Uint8Array> | null = null;

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				for (;;) {
					if (current) {
						const { done, value } = await current.read();
						if (!done) {
							controller.enqueue(value);
							return;
						}
						current = null;
					}
					if (!queue.length) {
						if (cursor === null) {
							controller.close();
							return;
						}
						const page = await mailbox.exportPage(cursor);
						queue = page.items;
						cursor = page.nextCursor;
						continue;
					}
					const item = queue.shift()!;
					const header =
						fromLine(item.source.from.address, item.receivedAt) +
						(item.labels.length ? `X-Mailbox-Labels: ${item.labels.join(",").replace(/[\r\n]/g, " ")}\r\n` : "");
					const body = (await messageBytes(bucket, item)).pipeThrough(mboxrdEscaper());
					controller.enqueue(encoder.encode(header));
					current = body.getReader();
				}
			},
			async cancel() {
				await current?.cancel();
			},
		},
		{ highWaterMark: 0 },
	);
}
