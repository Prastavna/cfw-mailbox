import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ADDRESS_BOOK_LIMITS, type SavedContact, type SavedContactInput } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label as FieldLabel } from "~/components/ui/label";
import { useAddressBookActions } from "~/lib/address-book";

const textareaClass =
	"w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export interface ContactDialogProps {
	mailboxId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Edit this contact; otherwise create one, starting from `seed`. */
	contact?: SavedContact | null;
	seed?: Partial<SavedContactInput>;
	onSaved?: (contact: SavedContact) => void;
}

export function ContactDialog({ mailboxId, open, onOpenChange, contact, seed, onSaved }: ContactDialogProps) {
	const { save } = useAddressBookActions(mailboxId);
	const [name, setName] = useState("");
	const [emails, setEmails] = useState<string[]>([""]);
	const [phone, setPhone] = useState("");
	const [company, setCompany] = useState("");
	const [notes, setNotes] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		const from = contact ?? seed ?? {};
		setName(from.name ?? "");
		setEmails(from.emails?.length ? [...from.emails] : [""]);
		setPhone(from.phone ?? "");
		setCompany(from.company ?? "");
		setNotes(from.notes ?? "");
		setError(null);
		// Only when the dialog opens: a parent re-rendering (new mail arriving) mustn't reset what's typed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		try {
			const saved = await save.mutateAsync({
				id: contact?.id,
				input: { name, emails: emails.map((x) => x.trim()).filter(Boolean), phone, company, notes },
			});
			toast(contact ? "Contact saved." : `${saved.name || saved.emails[0]} added to contacts.`);
			onSaved?.(saved);
			onOpenChange(false);
		} catch (err) {
			setError((err as Error).message);
		}
	};

	const setEmail = (i: number, value: string) => setEmails((list) => list.map((e, j) => (j === i ? value : e)));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{contact ? "Edit contact" : "New contact"}</DialogTitle>
						<DialogDescription className="sr-only">Name, email addresses and other details.</DialogDescription>
					</DialogHeader>
					<div className="grid gap-1.5">
						<FieldLabel htmlFor="contact-name">Name</FieldLabel>
						<Input id="contact-name" value={name} maxLength={ADDRESS_BOOK_LIMITS.name} onChange={(e) => setName(e.target.value)} autoFocus />
					</div>
					<fieldset className="grid gap-1.5">
						<legend className="mb-1.5 text-sm font-medium">Email</legend>
						{emails.map((email, i) => (
							<div key={i} className="flex gap-1">
								<Input
									type="email"
									value={email}
									onChange={(e) => setEmail(i, e.target.value)}
									aria-label={i === 0 ? "Email" : `Email ${i + 1}`}
									placeholder={i === 0 ? "name@example.com" : "Another address"}
								/>
								{emails.length > 1 && (
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onClick={() => setEmails((list) => list.filter((_, j) => j !== i))}
										aria-label={`Remove ${email || "address"}`}
									>
										<X />
									</Button>
								)}
							</div>
						))}
						{emails.length < ADDRESS_BOOK_LIMITS.emailsPerContact && (
							<div>
								<Button type="button" variant="ghost" size="sm" onClick={() => setEmails((list) => [...list, ""])}>
									<Plus aria-hidden /> Add email
								</Button>
							</div>
						)}
					</fieldset>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<FieldLabel htmlFor="contact-phone">Phone</FieldLabel>
							<Input id="contact-phone" type="tel" value={phone} maxLength={ADDRESS_BOOK_LIMITS.phone} onChange={(e) => setPhone(e.target.value)} />
						</div>
						<div className="grid gap-1.5">
							<FieldLabel htmlFor="contact-company">Company</FieldLabel>
							<Input id="contact-company" value={company} maxLength={ADDRESS_BOOK_LIMITS.company} onChange={(e) => setCompany(e.target.value)} />
						</div>
					</div>
					<div className="grid gap-1.5">
						<FieldLabel htmlFor="contact-notes">Notes</FieldLabel>
						<textarea
							id="contact-notes"
							rows={3}
							value={notes}
							maxLength={ADDRESS_BOOK_LIMITS.notes}
							onChange={(e) => setNotes(e.target.value)}
							className={textareaClass}
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={save.isPending}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
