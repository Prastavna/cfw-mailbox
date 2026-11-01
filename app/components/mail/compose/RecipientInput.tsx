import { X } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { isValidAddress } from "../../../../shared/address";
import type { EmailAddress } from "../../../../shared/api";
import { formatAddress, parseAddressList } from "~/lib/compose";
import { cn } from "~/lib/utils";

export interface RecipientInputHandle {
	/** Turns whatever is still typed into chips; returns the full list. */
	commit: () => EmailAddress[];
	focus: () => void;
}

interface RecipientInputProps {
	label: string;
	value: EmailAddress[];
	onChange: (value: EmailAddress[]) => void;
	autoFocus?: boolean;
	trailing?: React.ReactNode;
}

/** A row of address chips with a text box, Gmail style: Enter, comma, semicolon or leaving the box makes a chip. */
export const RecipientInput = forwardRef<RecipientInputHandle, RecipientInputProps>(function RecipientInput(
	{ label, value, onChange, autoFocus, trailing },
	ref,
) {
	const [text, setText] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const id = `recipients-${label.toLowerCase()}`;

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
		<div className="flex min-h-10 items-start border-b px-4" onClick={() => inputRef.current?.focus()}>
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
					className="h-7 min-w-24 flex-1 bg-transparent text-sm outline-none"
					value={text}
					onChange={(e) => {
						const v = e.target.value;
						if (/[,;]\s*$/.test(v)) commitText(v);
						else setText(v);
					}}
					onKeyDown={(e) => {
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
					onBlur={() => text.trim() && commitText(text)}
				/>
			</div>
			{trailing}
		</div>
	);
});
