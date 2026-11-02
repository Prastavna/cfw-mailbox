import { Download, Mail, MessagesSquare, MoreVertical, Pencil, Search, Trash2, Upload, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { OtherContact, SavedContact, SavedContactInput } from "../../shared/api";
import { ContactDialog } from "~/components/contacts/ContactDialog";
import { ConfirmDialog } from "~/components/mail/LabelDialog";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { matchesContact, useAddressBookActions, useOtherContacts, useSavedContacts } from "~/lib/address-book";
import { SEARCH_SEGMENT } from "~/lib/folders";
import { avatarColor, formatListDate, initial } from "~/lib/format";
import { useMailboxContext } from "~/lib/mailbox-context";

type Editing = { contact?: SavedContact; seed?: Partial<SavedContactInput> } | null;

/** The mailbox's address book: saved contacts, and people from your mail who aren't saved yet. */
export default function ContactsRoute() {
	const { mailbox, composer } = useMailboxContext();
	const navigate = useNavigate();
	const saved = useSavedContacts(mailbox.id);
	const [tab, setTab] = useState<"saved" | "other">("saved");
	const other = useOtherContacts(mailbox.id, tab === "other");
	const { remove, importFile, exportUrl } = useAddressBookActions(mailbox.id);
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState<Editing>(null);
	const [deleting, setDeleting] = useState<SavedContact[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const fileInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		document.title = `Contacts - ${mailbox.address} - Mail`;
	}, [mailbox.address]);

	const contacts = useMemo(() => (saved.data ?? []).filter((c) => matchesContact(c, query)), [saved.data, query]);
	const others = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (other.data ?? []).filter((o) => !q || o.address.includes(q) || o.name.toLowerCase().includes(q));
	}, [other.data, query]);
	const selectedContacts = contacts.filter((c) => selected.has(c.id));

	const email = (name: string, address: string) => composer.compose({ to: [{ name, address }] });
	const conversations = (addresses: string[]) => {
		const q = addresses.flatMap((a) => [`from:${a}`, `to:${a}`, `cc:${a}`]).join(" OR ");
		navigate(`/mail/${mailbox.id}/${SEARCH_SEGMENT}?q=${encodeURIComponent(q)}`);
	};

	const runImport = async (file: File) => {
		try {
			const r = await importFile.mutateAsync(file);
			const parts = [`${r.added} added`, r.updated ? `${r.updated} updated` : "", r.skipped ? `${r.skipped} skipped (no email address)` : ""];
			toast(`Contacts imported: ${parts.filter(Boolean).join(", ")}.`);
		} catch (err) {
			toast.error(`Couldn't import contacts: ${(err as Error).message}`);
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
				<h1 className="mr-auto text-lg font-medium">
					Contacts {saved.data && <span className="text-sm font-normal text-muted-foreground">({saved.data.length.toLocaleString()})</span>}
				</h1>
				<div className="relative order-last w-full sm:order-none sm:w-64">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
					<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contacts" aria-label="Search contacts" className="pl-8" />
				</div>
				<Button onClick={() => setEditing({})}>
					<UserPlus aria-hidden /> Create contact
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="Import and export">
							<MoreVertical />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => fileInput.current?.click()}>
							<Upload className="size-4" /> Import (.vcf)
						</DropdownMenuItem>
						<DropdownMenuItem asChild disabled={!saved.data?.length}>
							<a href={exportUrl} download>
								<Download className="size-4" /> Export (.vcf)
							</a>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<input
					ref={fileInput}
					type="file"
					accept=".vcf,text/vcard,text/x-vcard"
					className="hidden"
					aria-label="vCard file to import"
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (file) void runImport(file);
					}}
				/>
			</div>

			<Tabs value={tab} onValueChange={(v) => setTab(v as "saved" | "other")} className="min-h-0 flex-1 gap-0">
				<div className="flex items-center gap-2 px-4 pt-2">
					<TabsList>
						<TabsTrigger value="saved">Contacts</TabsTrigger>
						<TabsTrigger value="other">Other contacts</TabsTrigger>
					</TabsList>
					{tab === "saved" && selectedContacts.length > 0 && (
						<Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDeleting(selectedContacts)}>
							<Trash2 aria-hidden /> Delete {selectedContacts.length}
						</Button>
					)}
				</div>

				<TabsContent value="saved" className="min-h-0 overflow-y-auto">
					{saved.isPending ? (
						<ListSkeleton />
					) : contacts.length === 0 ? (
						<Empty>
							{query ? (
								"No contacts match your search."
							) : (
								<>
									No contacts yet. Create one, import a .vcf file, or add people from{" "}
									<button type="button" className="text-primary underline" onClick={() => setTab("other")}>
										Other contacts
									</button>
									.
								</>
							)}
						</Empty>
					) : (
						<ul aria-label="Contacts" className="divide-y pt-2">
							{contacts.map((c) => (
								<SavedRow
									key={c.id}
									contact={c}
									selected={selected.has(c.id)}
									onSelect={(on) =>
										setSelected((s) => {
											const next = new Set(s);
											if (on) next.add(c.id);
											else next.delete(c.id);
											return next;
										})
									}
									onEdit={() => setEditing({ contact: c })}
									onEmail={() => c.emails[0] && email(c.name, c.emails[0])}
									onConversations={() => conversations(c.emails)}
									onDelete={() => setDeleting([c])}
								/>
							))}
						</ul>
					)}
				</TabsContent>

				<TabsContent value="other" className="min-h-0 overflow-y-auto">
					<p className="px-4 pt-3 pb-1 text-xs text-muted-foreground">People you've written to or heard from who aren't in your contacts.</p>
					{other.isPending ? (
						<ListSkeleton />
					) : others.length === 0 ? (
						<Empty>{query ? "Nobody matches your search." : "Nobody yet."}</Empty>
					) : (
						<ul aria-label="Other contacts" className="divide-y">
							{others.map((o) => (
								<OtherRow
									key={o.address}
									person={o}
									onAdd={() => setEditing({ seed: { name: o.name, emails: [o.address] } })}
									onEmail={() => email(o.name, o.address)}
								/>
							))}
						</ul>
					)}
				</TabsContent>
			</Tabs>

			<ContactDialog
				mailboxId={mailbox.id}
				open={editing !== null}
				onOpenChange={(open) => !open && setEditing(null)}
				contact={editing?.contact}
				seed={editing?.seed}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={deleting?.length === 1 ? `Delete ${deleting[0]!.name || deleting[0]!.emails[0]}?` : `Delete ${deleting?.length} contacts?`}
				description="They're removed from your contacts. Your mail with them isn't touched."
				confirmLabel="Delete"
				onConfirm={async () => {
					const ids = deleting!.map((c) => c.id);
					try {
						const { deleted } = await remove.mutateAsync(ids);
						setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
						toast(deleted === 1 ? "Contact deleted." : `${deleted} contacts deleted.`);
					} catch (err) {
						toast.error(`Couldn't delete: ${(err as Error).message}`);
					}
				}}
			/>
		</div>
	);
}

function ContactAvatar({ name, address }: { name: string; address: string }) {
	return (
		<Avatar className="size-9 shrink-0">
			<AvatarFallback className="text-sm font-medium text-white" style={{ backgroundColor: avatarColor(address) }}>
				{initial({ name, address })}
			</AvatarFallback>
		</Avatar>
	);
}

interface SavedRowProps {
	contact: SavedContact;
	selected: boolean;
	onSelect: (on: boolean) => void;
	onEdit: () => void;
	onEmail: () => void;
	onConversations: () => void;
	onDelete: () => void;
}

function SavedRow({ contact: c, selected, onSelect, onEdit, onEmail, onConversations, onDelete }: SavedRowProps) {
	const label = c.name || c.emails[0] || "(no name)";
	return (
		<li className="group flex items-center gap-3 px-4 py-2 hover:bg-mail-hover" aria-label={label}>
			<Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label={`Select ${label}`} />
			<button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm" aria-label={`Edit ${label}`}>
				<ContactAvatar name={c.name} address={c.emails[0] ?? c.name} />
				<span className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)] sm:gap-4">
					<span className="block truncate font-medium">{c.name || <span className="text-muted-foreground">(no name)</span>}</span>
					<span className="block truncate text-muted-foreground sm:text-foreground">
						{c.emails[0]}
						{c.emails.length > 1 && <span className="text-muted-foreground"> +{c.emails.length - 1}</span>}
					</span>
					<span className="hidden truncate sm:block">{c.phone}</span>
					<span className="hidden truncate sm:block">{c.company}</span>
				</span>
			</button>
			<div className="flex shrink-0 items-center opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
				{c.emails.length > 0 && (
					<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={onEmail} aria-label={`Email ${label}`}>
						<Mail className="size-4" />
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={`More for ${label}`}>
							<MoreVertical className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={onEdit}>
							<Pencil className="size-4" /> Edit
						</DropdownMenuItem>
						{c.emails.length > 0 && (
							<DropdownMenuItem onSelect={onConversations}>
								<MessagesSquare className="size-4" /> View conversations
							</DropdownMenuItem>
						)}
						<DropdownMenuItem variant="destructive" onSelect={onDelete}>
							<Trash2 className="size-4" /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</li>
	);
}

function OtherRow({ person: o, onAdd, onEmail }: { person: OtherContact; onAdd: () => void; onEmail: () => void }) {
	return (
		<li className="flex items-center gap-3 px-4 py-2 text-sm" aria-label={o.name || o.address}>
			<ContactAvatar name={o.name} address={o.address} />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium">{o.name || o.address}</span>
				{o.name && <span className="block truncate text-muted-foreground">{o.address}</span>}
			</span>
			<span className="hidden shrink-0 text-xs text-muted-foreground sm:block" title="Last message">
				{formatListDate(o.lastContacted)}
			</span>
			<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={onEmail} aria-label={`Email ${o.name || o.address}`}>
				<Mail className="size-4" />
			</Button>
			<Button variant="outline" size="sm" onClick={onAdd} aria-label={`Add ${o.name || o.address} to contacts`}>
				<UserPlus aria-hidden /> <span className="hidden sm:inline">Add to contacts</span>
			</Button>
		</li>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return <p className="p-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function ListSkeleton() {
	return (
		<div className="flex flex-col" aria-busy aria-label="Loading contacts">
			{Array.from({ length: 8 }, (_, i) => (
				<div key={i} className="flex items-center gap-3 px-4 py-3">
					<Skeleton className="size-9 rounded-full" />
					<Skeleton className="h-3 w-40" />
					<Skeleton className="h-3 flex-1" />
				</div>
			))}
		</div>
	);
}
