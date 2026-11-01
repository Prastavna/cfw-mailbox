import { Ellipsis, ImageOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentInfo, MessageDetail } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { attachmentUrl } from "~/lib/api";
import { linkify, renderEmailHtml, splitQuotedText } from "~/lib/email-html";

interface EmailBodyProps {
	mailboxId: string;
	message: MessageDetail;
}

export function EmailBody({ mailboxId, message }: EmailBodyProps) {
	if (message.html) return <HtmlBody mailboxId={mailboxId} message={message} html={message.html} />;
	return <TextBody text={message.text ?? ""} />;
}

function QuoteToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
	return (
		<Button
			variant="secondary"
			size="xs"
			className="my-2 h-3 rounded-full px-1.5"
			onClick={onToggle}
			aria-label={shown ? "Hide trimmed content" : "Show trimmed content"}
			aria-expanded={shown}
		>
			<Ellipsis className="size-4" />
		</Button>
	);
}

function TextBody({ text }: { text: string }) {
	const [showQuoted, setShowQuoted] = useState(false);
	const { body, quoted } = useMemo(() => splitQuotedText(text), [text]);

	const render = (s: string) =>
		linkify(s).map((part, i) =>
			typeof part === "string" ? (
				part
			) : (
				<a key={i} href={part.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
					{part.url}
				</a>
			),
		);

	return (
		<div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
			{body ? render(body) : <span className="text-muted-foreground italic">(no message text)</span>}
			{quoted && (
				<>
					<div>
						<QuoteToggle shown={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />
					</div>
					{showQuoted && <div className="text-muted-foreground">{render(quoted)}</div>}
				</>
			)}
		</div>
	);
}

function HtmlBody({ mailboxId, message, html }: EmailBodyProps & { html: string }) {
	const [showImages, setShowImages] = useState(false);
	const [showQuoted, setShowQuoted] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(80);

	const inlineImageUrl = useCallback(
		(a: AttachmentInfo) => attachmentUrl(mailboxId, message.id, a.id, true),
		[mailboxId, message.id],
	);
	const rendered = useMemo(
		() =>
			renderEmailHtml(html, {
				attachments: message.attachments,
				inlineImageUrl,
				showRemoteImages: showImages,
				showQuoted,
			}),
		[html, message.attachments, inlineImageUrl, showImages, showQuoted],
	);

	// Size the iframe to its content, and keep it sized as images load.
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) return;
		let observer: ResizeObserver | undefined;
		const measure = () => {
			const doc = iframe.contentDocument;
			if (doc?.documentElement) setHeight(Math.max(40, doc.documentElement.scrollHeight));
		};
		const onLoad = () => {
			measure();
			observer?.disconnect();
			const body = iframe.contentDocument?.body;
			if (body) {
				observer = new ResizeObserver(measure);
				observer.observe(body);
			}
		};
		iframe.addEventListener("load", onLoad);
		return () => {
			iframe.removeEventListener("load", onLoad);
			observer?.disconnect();
		};
	}, []);

	return (
		<div>
			{rendered.hasRemoteContent && !showImages && (
				<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2 text-sm">
					<ImageOff className="size-4 text-muted-foreground" aria-hidden />
					<span className="text-muted-foreground">Images are hidden to protect your privacy.</span>
					<Button variant="link" size="sm" className="h-auto p-0" onClick={() => setShowImages(true)}>
						Display images
					</Button>
				</div>
			)}
			<iframe
				ref={iframeRef}
				title={`Message from ${message.from.name || message.from.address}`}
				srcDoc={rendered.document}
				// No allow-scripts: email can never run code. allow-same-origin only lets us measure its height.
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				referrerPolicy="no-referrer"
				className="w-full rounded-sm border-0 bg-white"
				style={{ height }}
			/>
			{rendered.hasQuoted && <QuoteToggle shown={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
		</div>
	);
}
