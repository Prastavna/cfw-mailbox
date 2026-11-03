import type { Editor } from "@tiptap/react";
import { AlertCircle, Ellipsis, Loader2, Maximize2, Minimize2, Minus, Paperclip, Sparkles, Trash2, Type, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { isValidAddress } from "../../../../shared/address";
import type { AttachmentInfo, CreateDraftRequest, DraftDetail, DraftFields, EmailAddress, MailboxAccess, SendResult } from "../../../../shared/api";
import { SEND_LIMITS } from "../../../../shared/api";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMediaQuery } from "~/hooks/use-media-query";
import { attachmentUrl } from "~/lib/api";
import { invalidAddresses, splitDraftHtml } from "~/lib/compose";
import { type ComposeWindow, draftsApi, useComposer, useComposeStore } from "~/lib/compose-store";
import { renderEmailHtml } from "~/lib/email-html";
import { useAiReady } from "~/lib/extensions";
import { formatSize } from "~/lib/format";
import { ComposeAssist } from "~/components/extensions/ai/ComposeAssist";
import { cn } from "~/lib/utils";
import { RenderBoundary } from "~/components/mail/EmailBody";
import { FormattingToolbar, RichEditor } from "./RichEditor";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";

/** Bottom-right stack of compose windows for the open mailbox. */
export function ComposeDock({ mailbox }: { mailbox: MailboxAccess }) {
	const all = useComposeStore((s) => s.windows);
	const windows = all.filter((w) => w.mailboxId === mailbox.id);
	if (!windows.length) return null;
	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-row-reverse items-end gap-3 md:px-4">
			{windows.map((w) => (
				<ComposeFrame key={w.key} win={w} mailbox={mailbox} />
			))}
		</div>
	);
}

/** What the form starts with, from a seed (new window) or a saved draft. */
interface Initial {
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	subject: string;
	body: string;
	quote: string | null;
	parent?: CreateDraftRequest["parent"];
	attachments: AttachmentInfo[];
	/** The attachments are a forward's originals, not yet copied into a draft. */
	inherited: boolean;
	sendError: string | null;
}

function fromDraft(d: DraftDetail): Initial {
	const { body, quote } = splitDraftHtml(d.html);
	return { ...d, body, quote, attachments: d.attachments, inherited: false, sendError: d.sendError };
}

function ComposeFrame({ win, mailbox }: { win: ComposeWindow; mailbox: MailboxAccess }) {
	const { update, close } = useComposeStore.getState();
	const desktop = useMediaQuery("(min-width: 768px)");
	const [initial, setInitial] = useState<Initial | null>(() =>
		win.seed ? { ...win.seed, attachments: win.seed.inheritedAttachments, inherited: win.seed.inheritedAttachments.length > 0, sendError: null } : null,
	);

	useEffect(() => {
		if (initial || !win.draftId) return;
		let cancelled = false;
		draftsApi.get(mailbox.id, win.draftId).then(
			(d) => {
				if (cancelled) return;
				if (d.sendAt !== null) {
					toast("This message is being sent.");
					close(win.key);
					return;
				}
				setInitial(fromDraft(d));
				update(win.key, { title: d.subject || "New Message" });
			},
			(err: Error) => {
				if (cancelled) return;
				toast.error(`Couldn't open the draft: ${err.message}`);
				close(win.key);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [initial, win.draftId, win.key, mailbox.id, update, close]);

	const maximized = win.maximized && !win.minimized;
	const fullscreen = !desktop && !win.minimized;

	return (
		<>
			{maximized && desktop && (
				<div className="pointer-events-auto fixed inset-0 z-40 bg-black/40" onClick={() => update(win.key, { maximized: false })} aria-hidden />
			)}
			<section
				role="dialog"
				aria-label={win.title || "New Message"}
				className={cn(
					"pointer-events-auto flex flex-col overflow-hidden bg-background shadow-[0_8px_10px_1px_rgba(0,0,0,.14),0_3px_14px_2px_rgba(0,0,0,.12)]",
					fullscreen
						? "fixed inset-0 z-50"
						: maximized
							? "fixed top-1/2 left-1/2 z-50 h-[90svh] w-[min(1100px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg"
							: win.minimized
								? "w-[min(270px,100vw)] rounded-t-lg"
								: "h-[min(560px,calc(100svh-72px))] w-[min(540px,100vw)] rounded-t-lg",
				)}
			>
				<header
					className="flex h-10 shrink-0 cursor-pointer items-center gap-1 bg-mail-canvas pr-1.5 pl-4 text-sm font-medium"
					onClick={() => update(win.key, { minimized: !win.minimized })}
				>
					<span className="flex-1 truncate">{win.title || "New Message"}</span>
					<HeaderButton label={win.minimized ? "Restore" : "Minimize"} onClick={() => update(win.key, { minimized: !win.minimized })}>
						<Minus />
					</HeaderButton>
					{desktop && (
						<HeaderButton
							label={maximized ? "Exit full screen" : "Full screen"}
							onClick={() => update(win.key, { maximized: !maximized, minimized: false })}
						>
							{maximized ? <Minimize2 /> : <Maximize2 />}
						</HeaderButton>
					)}
					<HeaderButton label="Save & close" onClick={() => close(win.key)}>
						<X />
					</HeaderButton>
				</header>
				{initial ? (
					<div className={cn("flex min-h-0 flex-1 flex-col", win.minimized && "hidden")}>
						<ComposeForm win={win} mailbox={mailbox} initial={initial} />
					</div>
				) : (
					!win.minimized && (
						<div className="space-y-3 p-4" aria-busy>
							<Skeleton className="h-6 w-2/3" />
							<Skeleton className="h-6 w-1/2" />
							<Skeleton className="h-32 w-full" />
						</div>
					)
				)}
			</section>
		</>
	);
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={label}
					className="rounded-sm hover:bg-foreground/10 [&_svg]:size-4"
					onClick={(e) => {
						e.stopPropagation();
						onClick();
					}}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

const AUTOSAVE_MS = 1500;

function ComposeForm({ win, mailbox, initial }: { win: ComposeWindow; mailbox: MailboxAccess; initial: Initial }) {
	const { update, close } = useComposeStore.getState();
	const composer = useComposer(mailbox);
	const navigate = useNavigate();

	const [to, setTo] = useState(initial.to);
	const [cc, setCc] = useState(initial.cc);
	const [bcc, setBcc] = useState(initial.bcc);
	const [showCc, setShowCc] = useState(initial.cc.length > 0);
	const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
	const [subject, setSubject] = useState(initial.subject);
	const [attachments, setAttachments] = useState(initial.attachments);
	const [uploading, setUploading] = useState<{ key: string; name: string; size: number }[]>([]);
	const [showQuote, setShowQuote] = useState(initial.parent?.kind === "forward");
	const [showToolbar, setShowToolbar] = useState(true);
	const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(win.draftId ? "saved" : "idle");
	const [sending, setSending] = useState(false);
	const [editor, setEditor] = useState<Editor | null>(null);
	const aiReady = useAiReady();
	const [assistOpen, setAssistOpen] = useState(false);
	// Saves can run after unmount (closing saves), so they read the editor through a ref.
	const editorRef = useRef<Editor | null>(null);

	const draftId = useRef(win.draftId);
	const dirty = useRef(false);
	const inherited = useRef(initial.inherited);
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const latest = useRef({ to, cc, bcc, subject });
	const toRef = useRef<RecipientInputHandle>(null);
	const ccRef = useRef<RecipientInputHandle>(null);
	const bccRef = useRef<RecipientInputHandle>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const fields = (): DraftFields => {
		const valid = (list: EmailAddress[]) => list.filter((a) => isValidAddress(a.address));
		const { to, cc, bcc, subject } = latest.current;
		return { to: valid(to), cc: valid(cc), bcc: valid(bcc), subject, html: (editorRef.current?.getHTML() ?? initial.body) + (initial.quote ?? "") };
	};

	/** Saves the draft (creating it the first time). Saves run one after another. */
	const persist = (force = false): Promise<string> => {
		const run = async () => {
			if (!force && !dirty.current && draftId.current) return draftId.current;
			dirty.current = false;
			setStatus("saving");
			try {
				if (!draftId.current) {
					const draft = await draftsApi.create(mailbox.id, { ...fields(), parent: initial.parent });
					draftId.current = draft.id;
					update(win.key, { draftId: draft.id });
					if (inherited.current) {
						inherited.current = false;
						setAttachments(draft.attachments);
					}
				} else {
					await draftsApi.update(mailbox.id, draftId.current, fields());
				}
				setStatus("saved");
				return draftId.current;
			} catch (err) {
				dirty.current = true;
				setStatus("error");
				throw err;
			}
		};
		const p = queue.current.then(run, run);
		queue.current = p.catch(() => {});
		return p;
	};

	const changed = () => {
		dirty.current = true;
		setStatus((s) => (s === "saving" ? s : "idle"));
		clearTimeout(timer.current);
		timer.current = setTimeout(() => persist().catch(() => {}), AUTOSAVE_MS);
	};

	const setField = <K extends keyof typeof latest.current>(key: K, setter: (v: (typeof latest.current)[K]) => void) => (v: (typeof latest.current)[K]) => {
		latest.current = { ...latest.current, [key]: v };
		setter(v);
		changed();
	};

	// Closing the window (or it being pushed out by a newer one) saves pending edits.
	useEffect(
		() => () => {
			clearTimeout(timer.current);
			if (dirty.current) persist().catch((err: Error) => toast.error(`Couldn't save the draft: ${err.message}`));
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	const discard = async () => {
		clearTimeout(timer.current);
		dirty.current = false;
		close(win.key);
		await queue.current;
		if (draftId.current) {
			try {
				await draftsApi.discard(mailbox.id, draftId.current);
			} catch (err) {
				toast.error(`Couldn't discard the draft: ${(err as Error).message}`);
				return;
			}
		}
		toast("Draft discarded.");
	};

	const send = async () => {
		if (sending) return;
		const lists = {
			to: toRef.current?.commit() ?? to,
			cc: ccRef.current?.commit() ?? cc,
			bcc: bccRef.current?.commit() ?? bcc,
		};
		latest.current = { ...latest.current, ...lists };
		const everyone = [...lists.to, ...lists.cc, ...lists.bcc];
		if (!everyone.length) {
			toast.error("Please specify at least one recipient.");
			toRef.current?.focus();
			return;
		}
		const bad = invalidAddresses(everyone);
		if (bad.length) {
			toast.error(`The address "${bad[0]!.address}" wasn't recognised. Please make sure that all addresses are properly formed.`);
			return;
		}
		if (everyone.length > SEND_LIMITS.recipients) {
			toast.error(`A message can have at most ${SEND_LIMITS.recipients} recipients.`);
			return;
		}
		if (uploading.length) {
			toast.error("Wait for attachments to finish uploading.");
			return;
		}
		const bodyText = editor?.getText().trim() ?? "";
		if (!subject.trim() && !bodyText && !window.confirm("Send this message without a subject or text in the body?")) return;

		setSending(true);
		clearTimeout(timer.current);
		try {
			const id = await persist(true);
			const result = await draftsApi.send(mailbox.id, id);
			dirty.current = false;
			close(win.key);
			announceSent(result);
		} catch (err) {
			toast.error((err as Error).message);
			setSending(false);
		}
	};

	const announceSent = (result: SendResult) => {
		const view = { label: "View message", onClick: () => navigate(`/mail/${mailbox.id}/sent/${result.threadId}`) };
		if (result.status === "sent") {
			toast("Message sent.", { action: view });
			return;
		}
		toast("Message sent.", {
			duration: Math.max(4000, result.sendAt - Date.now()),
			action: {
				label: "Undo",
				onClick: async () => {
					try {
						const draft = await draftsApi.cancelSend(mailbox.id, result.draftId);
						composer.openDraft(draft.id, draft.subject || "New Message");
						toast("Sending undone.");
					} catch (err) {
						toast.error((err as Error).message);
					}
				},
			},
			cancel: view,
		});
	};

	const addFiles = async (files: File[]) => {
		const used = attachments.reduce((n, a) => n + a.size, 0) + uploading.reduce((n, u) => n + u.size, 0);
		let budget = SEND_LIMITS.messageBytes - used;
		for (const file of files) {
			if (file.size > budget) {
				toast.error(`"${file.name}" is too large: attachments can add up to at most 25 MB.`);
				continue;
			}
			budget -= file.size;
			const key = crypto.randomUUID();
			setUploading((u) => [...u, { key, name: file.name, size: file.size }]);
			try {
				const id = draftId.current ?? (await persist(true));
				const info = await draftsApi.upload(mailbox.id, id, file);
				setAttachments((a) => [...a, info]);
			} catch (err) {
				toast.error(`Couldn't attach "${file.name}": ${(err as Error).message}`);
			} finally {
				setUploading((u) => u.filter((x) => x.key !== key));
			}
		}
	};

	const removeAttachment = async (a: AttachmentInfo) => {
		try {
			let target = a;
			if (inherited.current) {
				// A forward's attachments are copied into the draft when it's created; find the copy.
				const index = attachments.indexOf(a);
				const id = await persist(true);
				const draft = await draftsApi.get(mailbox.id, id);
				setAttachments(draft.attachments);
				target = draft.attachments[index] ?? a;
			}
			await draftsApi.removeAttachment(mailbox.id, draftId.current!, target.id);
			setAttachments((list) => list.filter((x) => x.id !== target.id));
		} catch (err) {
			toast.error(`Couldn't remove "${a.filename}": ${(err as Error).message}`);
		}
	};

	const visibleAttachments = attachments.filter((a) => a.disposition === "attachment");
	const statusText = { idle: "", saving: "Saving…", saved: "Draft saved", error: "Couldn't save" }[status];

	return (
		<div
			className="flex min-h-0 flex-1 flex-col"
			onKeyDown={(e) => {
				if (e.key === "Escape" && !e.defaultPrevented) {
					e.preventDefault();
					close(win.key);
				} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					void send();
				}
			}}
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes("Files")) e.preventDefault();
			}}
			onDrop={(e) => {
				if (!e.dataTransfer.files.length) return;
				e.preventDefault();
				void addFiles([...e.dataTransfer.files]);
			}}
		>
			{initial.sendError && (
				<div role="alert" className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
					<AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span>Not sent: {initial.sendError}</span>
				</div>
			)}
			<div className="flex h-9 items-center border-b px-4 text-sm">
				<span className="w-14 shrink-0 text-muted-foreground">From</span>
				<span className="truncate">
					{mailbox.displayName} &lt;{mailbox.address}&gt;
				</span>
			</div>
			<RecipientInput
				ref={toRef}
				label="To"
				mailboxId={mailbox.id}
				value={to}
				onChange={setField("to", setTo)}
				autoFocus={!initial.to.length && !initial.parent}
				trailing={
					<div className="flex shrink-0 gap-1 py-2 text-sm text-muted-foreground">
						{!showCc && (
							<button type="button" className="hover:underline" onClick={() => setShowCc(true)}>
								Cc
							</button>
						)}
						{!showBcc && (
							<button type="button" className="hover:underline" onClick={() => setShowBcc(true)}>
								Bcc
							</button>
						)}
					</div>
				}
			/>
			{showCc && <RecipientInput ref={ccRef} label="Cc" mailboxId={mailbox.id} value={cc} onChange={setField("cc", setCc)} autoFocus={!initial.cc.length} />}
			{showBcc && <RecipientInput ref={bccRef} label="Bcc" mailboxId={mailbox.id} value={bcc} onChange={setField("bcc", setBcc)} autoFocus={!initial.bcc.length} />}
			<input
				aria-label="Subject"
				placeholder="Subject"
				maxLength={SEND_LIMITS.subjectChars}
				className="h-10 shrink-0 border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
				value={subject}
				onChange={(e) => {
					setField("subject", setSubject)(e.target.value);
					update(win.key, { title: e.target.value || "New Message" });
				}}
			/>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<RichEditor
					initialHtml={initial.body}
					autoFocus={!!initial.parent && initial.to.length > 0}
					onReady={(e) => {
						editorRef.current = e;
						setEditor(e);
					}}
					onChange={changed}
					onSubmit={() => void send()}
					className="min-h-24 flex-none overflow-visible"
				/>
				{initial.quote && (
					<div className="px-4 pb-2">
						<Button
							variant="secondary"
							size="xs"
							className="h-3 rounded-full px-1.5"
							onClick={() => setShowQuote((v) => !v)}
							aria-label={showQuote ? "Hide trimmed content" : "Show trimmed content"}
							aria-expanded={showQuote}
						>
							<Ellipsis className="size-4" />
						</Button>
						{showQuote && (
							<RenderBoundary fallback={null}>
								<QuotePreview html={initial.quote} mailboxId={mailbox.id} draftId={draftId.current} attachments={attachments} />
							</RenderBoundary>
						)}
					</div>
				)}
				{(visibleAttachments.length > 0 || uploading.length > 0) && (
					<ul className="flex flex-col gap-1 px-4 pb-2" aria-label="Attachments">
						{visibleAttachments.map((a) => (
							<li key={a.id} className="flex items-center gap-2 rounded-sm bg-muted/60 px-2.5 py-1 text-sm">
								<Paperclip className="size-3.5 text-muted-foreground" aria-hidden />
								<span className="min-w-0 flex-1 truncate font-medium text-primary">{a.filename}</span>
								<span className="text-xs text-muted-foreground">({formatSize(a.size)})</span>
								<button
									type="button"
									className="rounded-full p-0.5 hover:bg-foreground/10"
									aria-label={`Remove attachment ${a.filename}`}
									onClick={() => void removeAttachment(a)}
								>
									<X className="size-3.5" />
								</button>
							</li>
						))}
						{uploading.map((u) => (
							<li key={u.key} className="flex items-center gap-2 rounded-sm bg-muted/60 px-2.5 py-1 text-sm">
								<Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
								<span className="min-w-0 flex-1 truncate">{u.name}</span>
								<span className="text-xs text-muted-foreground">Uploading…</span>
							</li>
						))}
					</ul>
				)}
			</div>

			{aiReady && assistOpen && editor && (
				<ComposeAssist
					editor={editor}
					mailboxId={mailbox.id}
					parentMessageId={initial.parent?.messageId}
					subject={subject}
					to={[...to, ...cc].map((a) => a.address)}
					onClose={() => setAssistOpen(false)}
				/>
			)}
			{showToolbar && <FormattingToolbar editor={editor} />}
			<footer className="flex shrink-0 items-center gap-1 px-3 pt-1 pb-3">
				<Button className="h-9 rounded-full px-6 font-medium" onClick={() => void send()} disabled={sending}>
					{sending && <Loader2 className="animate-spin" aria-hidden />}
					Send
				</Button>
				<ToolTipButton label="Formatting options" pressed={showToolbar} onClick={() => setShowToolbar((v) => !v)}>
					<Type />
				</ToolTipButton>
				<ToolTipButton label="Attach files" onClick={() => fileRef.current?.click()}>
					<Paperclip />
				</ToolTipButton>
				{aiReady && (
					<ToolTipButton label="Help me write" pressed={assistOpen} onClick={() => setAssistOpen((v) => !v)}>
						<Sparkles className="text-violet-600 dark:text-violet-400" />
					</ToolTipButton>
				)}
				<input
					ref={fileRef}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						const files = [...(e.target.files ?? [])];
						e.target.value = "";
						void addFiles(files);
					}}
				/>
				<span className="ml-2 flex-1 truncate text-xs text-muted-foreground" aria-live="polite">
					{statusText}
				</span>
				<ToolTipButton label="Discard draft" onClick={() => void discard()}>
					<Trash2 />
				</ToolTipButton>
			</footer>
		</div>
	);
}

function ToolTipButton({
	label,
	onClick,
	pressed,
	children,
}: {
	label: string;
	onClick: () => void;
	pressed?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label={label}
					aria-pressed={pressed}
					onClick={onClick}
					className={cn("rounded-full [&_svg]:size-[18px]", pressed && "bg-mail-active text-mail-active-foreground")}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/** Read-only view of the quoted message, rendered as safely as any received mail. */
function QuotePreview({
	html,
	mailboxId,
	draftId,
	attachments,
}: {
	html: string;
	mailboxId: string;
	draftId: string | null;
	attachments: AttachmentInfo[];
}) {
	const [height, setHeight] = useState(120);
	const ref = useRef<HTMLIFrameElement>(null);
	const doc = useMemo(
		() =>
			renderEmailHtml(html, {
				attachments: draftId ? attachments : [],
				inlineImageUrl: (a) => attachmentUrl(mailboxId, draftId ?? "", a.id, true),
				showRemoteImages: false,
				showQuoted: true,
			}).document,
		[html, mailboxId, draftId, attachments],
	);
	return (
		<iframe
			ref={ref}
			title="Quoted message"
			srcDoc={doc}
			sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			referrerPolicy="no-referrer"
			className="mt-2 w-full border-0 bg-white"
			style={{ height }}
			onLoad={() => {
				const h = ref.current?.contentDocument?.documentElement.scrollHeight;
				if (h) setHeight(Math.min(h, 2000));
			}}
		/>
	);
}
