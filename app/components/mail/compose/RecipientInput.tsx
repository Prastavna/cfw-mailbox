import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { isValidAddress } from "../../../../shared/address";
import type { Contact, EmailAddress } from "../../../../shared/api";
import { apiFetch } from "~/lib/api";
import { formatAddress, parseAddressList } from "~/lib/compose";
import { cn } from "~/lib/utils";

export interface RecipientInputHandle {
	/** Turns whatever is still typed into chips; returns the full list. */
	commit: () => EmailAddress[];
	focus: () => void;
}

interface RecipientInputProps {
	label: string;
	/** Mailbox whose contacts are suggested. */
	mailboxId: string;
	value: EmailAddress[];
	onChange: (value: EmailAddress[]) => void;
	autoFocus?: boolean;
	trailing?: React.ReactNode;
}

/** A row of address chips with a text box, Gmail style: Enter, comma, semicolon or leaving the box makes a chip. */
export const RecipientInput = forwardRef<RecipientInputHandle, RecipientInputProps>(function RecipientInput(
	{ label, mailboxId, value, onChange, autoFocus, trailing },
	ref,
) {
	const [text, setText] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const id = `recipients-${label.toLowerCase()}`;
	const listId = useId();
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [active, setActive] = useState(0);

	// Debounce what we ask the server for; the list updates as the person types.
	const term = text.trim();
	const [debounced, setDebounced] = useState(term);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(term), 120);
		return () => clearTimeout(t);
	}, [term]);
	const suggestions = useQuery({
		queryKey: ["mailbox", mailboxId, "contacts", debounced],
		queryFn: () => apiFetch<Contact[]>(`/mailboxes/${mailboxId}/contacts?q=${encodeURIComponent(debounced)}&limit=8`),
		enabled: debounced.length > 0 && !/[,;]/.test(debounced),
		staleTime: 30_000,
		placeholderData: (prev) => prev,
	});
	const chosen = new Set(value.map((a) => a.address.toLowerCase()));
	const options = term ? (suggestions.data ?? []).filter((c) => !chosen.has(c.address.toLowerCase())) : [];
	const open = focused && !dismissed && options.length > 0;
	useEffect(() => setActive(0), [debounced]);
	useEffect(() => setDismissed(false), [term]);

	const choose = (c: Contact) => {
		setText("");
		if (!chosen.has(c.address.toLowerCase())) onChange([...value, { name: c.name, address: c.address }]);
		inputRef.current?.focus();
	};

	const commitText = (raw: string): EmailAddress[] => {
		const added = parseAddressList(raw);
		setText("");
		if (!added.length) return value;
		const known = new Set(value.map((a) => a.address));
		const next = [...value, ...added.filter((a) => !known.has(a.address))];
		onChange(next);
		return next;
	};

	useImperativeHandle(ref, () => ({
		commit: () => (text.trim() ? commitText(text) : value),
		focus: () => inputRef.current?.focus(),
	}));

	const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

	return (
		<div className="relative flex min-h-10 items-start border-b px-4" onClick={() => inputRef.current?.focus()}>
			<label htmlFor={id} className="w-14 shrink-0 py-2.5 text-sm text-muted-foreground">
				{label}
			</label>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1.5">
				{value.map((a, i) => {
					const valid = isValidAddress(a.address);
					return (
						<span
							key={`${a.address}-${i}`}
							title={valid ? formatAddress(a) : `"${a.address}" doesn't look like an email address`}
							className={cn(
								"inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-sm",
								valid ? "bg-muted/60" : "border-destructive/60 bg-destructive/10 text-destructive",
							)}
						>
							<span className="truncate">{a.name || a.address}</span>
							<button
								type="button"
								className="rounded-full p-0.5 hover:bg-foreground/10"
								aria-label={`Remove ${a.name || a.address}`}
								onClick={(e) => {
									e.stopPropagation();
									remove(i);
								}}
							>
								<X className="size-3" />
							</button>
						</span>
					);
				})}
				<input
					ref={inputRef}
					id={id}
					type="text"
					autoComplete="off"
					autoFocus={autoFocus}
					aria-label={`${label} recipients`}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={open}
					aria-controls={open ? listId : undefined}
					aria-activedescendant={open ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
					className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none"
					value={text}
					onChange={(e) => {
						const v = e.target.value;
						if (/[,;]\s*$/.test(v)) commitText(v);
						else setText(v);
					}}
					onFocus={() => setFocused(true)}
					onKeyDown={(e) => {
						if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
							e.preventDefault();
							const step = e.key === "ArrowDown" ? 1 : -1;
							setActive((i) => (Math.min(i, options.length - 1) + step + options.length) % options.length);
							return;
						}
						if (open && e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							setDismissed(true);
							return;
						}
						if (open && (e.key === "Enter" || e.key === "Tab")) {
							e.preventDefault();
							choose(options[Math.min(active, options.length - 1)]!);
							return;
						}
						if ((e.key === "Enter" || e.key === "Tab") && text.trim()) {
							e.preventDefault();
							commitText(text);
						} else if (e.key === "Backspace" && !text && value.length) {
							e.preventDefault();
							const last = value.at(-1)!;
							onChange(value.slice(0, -1));
							setText(formatAddress(last));
						}
					}}
					onPaste={(e) => {
						const pasted = e.clipboardData.getData("text");
						if (/[,;\n]/.test(pasted)) {
							e.preventDefault();
							commitText(text + pasted);
						}
					}}
					onBlur={() => {
						setFocused(false);
						if (text.trim()) commitText(text);
					}}
				/>
			</div>
			{open && (
				<ul
					id={listId}
					role="listbox"
					aria-label="Suggested recipients"
					className="absolute top-full left-16 z-50 mt-0.5 w-[min(360px,calc(100%-5rem))] overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
				>
					{options.map((c, i) => (
						<li
							key={c.address}
							id={`${listId}-${i}`}
							role="option"
							aria-selected={i === Math.min(active, options.length - 1)}
							className="flex cursor-pointer flex-col px-3 py-1.5 text-sm aria-selected:bg-accent"
							// mousedown, so the input doesn't blur and commit the typed text first.
							onMouseDown={(e) => {
								e.preventDefault();
								choose(c);
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="truncate">{c.name || c.address}</span>
							{c.name && <span className="truncate text-xs text-muted-foreground">{c.address}</span>}
						</li>
					))}
				</ul>
			)}
			{trailing}
		</div>
	);
});
