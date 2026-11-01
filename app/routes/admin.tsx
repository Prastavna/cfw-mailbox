import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, Globe, Inbox, Plus, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { Domain, Mailbox, MailboxRole, Member } from "../../shared/api";
import { ConfirmDialog } from "~/components/mail/LabelDialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { TooltipProvider } from "~/components/ui/tooltip";
import { apiFetch, queryKeys, useMe } from "~/lib/api";
import type { Route } from "./+types/admin";

export function meta(_: Route.MetaArgs) {
	return [{ title: "Manage mailboxes - Mail" }];
}

const adminKeys = {
	domains: ["admin", "domains"] as const,
	mailboxes: ["admin", "mailboxes"] as const,
	members: (id: string) => ["admin", "members", id] as const,
};

/** Admin screen: domains this install serves, mailboxes on them, and who can open each. */
export default function AdminPage() {
	const { data: me, isPending } = useMe();

	if (isPending) return <div className="min-h-svh bg-mail-canvas" aria-busy />;
	if (!me?.isAdmin) {
		return (
			<main className="flex min-h-svh items-center justify-center bg-mail-canvas p-6 text-center text-sm">
				<p>
					Only administrators can manage mailboxes.{" "}
					<Link to="/" className="text-primary underline">
						Back to mail
					</Link>
				</p>
			</main>
		);
	}

	return (
		<TooltipProvider>
			<div className="min-h-svh bg-mail-canvas">
				<header className="flex h-16 items-center gap-3 px-4">
					<Button variant="ghost" size="icon-lg" className="rounded-full" asChild>
						<Link to="/" aria-label="Back to mail">
							<ArrowLeft className="size-5" />
						</Link>
					</Button>
					<h1 className="text-xl">Manage mailboxes</h1>
					<span className="text-muted-foreground ml-auto text-sm">{me.email}</span>
				</header>
				<main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pb-16">
					<DomainsSection />
					<MailboxesSection />
				</main>
			</div>
		</TooltipProvider>
	);
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Globe; children: React.ReactNode }) {
	return (
		<section className="rounded-2xl bg-mail-surface p-5 shadow-xs">
			<h2 className="mb-4 flex items-center gap-2 text-base font-medium">
				<Icon className="size-5 text-muted-foreground" aria-hidden /> {title}
			</h2>
			{children}
		</section>
	);
}

function useInvalidateAll() {
	const queryClient = useQueryClient();
	return () => {
		queryClient.invalidateQueries({ queryKey: ["admin"] });
		queryClient.invalidateQueries({ queryKey: queryKeys.me });
	};
}

// ---- Domains -----------------------------------------------------------------

function DomainsSection() {
	const { data: domains } = useQuery({ queryKey: adminKeys.domains, queryFn: () => apiFetch<Domain[]>("/admin/domains") });
	const invalidate = useInvalidateAll();
	const [domain, setDomain] = useState("");
	const [removing, setRemoving] = useState<string | null>(null);

	const add = useMutation({
		mutationFn: (d: string) => apiFetch<Domain>("/admin/domains", { method: "POST", body: JSON.stringify({ domain: d }) }),
		onSuccess: (d) => {
			toast(`Added ${d.domain}.`);
			setDomain("");
			invalidate();
		},
		onError: (err) => toast.error(err.message),
	});
	const remove = useMutation({
		mutationFn: (d: string) => apiFetch(`/admin/domains/${encodeURIComponent(d)}`, { method: "DELETE" }),
		onSuccess: (_, d) => {
			toast(`Removed ${d}.`);
			invalidate();
		},
		onError: (err) => toast.error(err.message),
	});

	return (
		<Section title="Domains" icon={Globe}>
			<p className="text-muted-foreground mb-4 text-sm">
				For each domain, turn on Cloudflare Email Routing and add a catch-all rule that sends to this Worker. Mail to addresses
				without a mailbox is rejected.
			</p>
			<ul className="mb-4 divide-y rounded-lg border">
				{domains?.length === 0 && <li className="text-muted-foreground p-3 text-sm">No domains yet.</li>}
				{domains?.map((d) => (
					<li key={d.domain} className="flex items-center justify-between p-3 text-sm">
						<span className="font-medium">{d.domain}</span>
						<Button variant="ghost" size="icon-sm" onClick={() => setRemoving(d.domain)} aria-label={`Remove ${d.domain}`}>
							<Trash2 className="size-4" />
						</Button>
					</li>
				))}
			</ul>
			<form
				className="flex items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					add.mutate(domain.trim());
				}}
			>
				<div className="flex flex-1 flex-col gap-1.5">
					<Label htmlFor="new-domain">Add domain</Label>
					<Input id="new-domain" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
				</div>
				<Button type="submit" disabled={!domain.trim() || add.isPending}>
					<Plus className="size-4" /> Add
				</Button>
			</form>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={`Remove ${removing}?`}
				description="Only domains without mailboxes can be removed."
				confirmLabel="Remove"
				onConfirm={() => remove.mutate(removing!)}
			/>
		</Section>
	);
}

// ---- Mailboxes ---------------------------------------------------------------

function MailboxesSection() {
	const { data: domains } = useQuery({ queryKey: adminKeys.domains, queryFn: () => apiFetch<Domain[]>("/admin/domains") });
	const { data: mailboxes } = useQuery({ queryKey: adminKeys.mailboxes, queryFn: () => apiFetch<Mailbox[]>("/admin/mailboxes") });
	const invalidate = useInvalidateAll();
	const [local, setLocal] = useState("");
	const [domain, setDomain] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [owner, setOwner] = useState("");
	const [open, setOpen] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Mailbox | null>(null);
	const chosenDomain = domain || domains?.[0]?.domain || "";

	const create = useMutation({
		mutationFn: () =>
			apiFetch<Mailbox>("/admin/mailboxes", {
				method: "POST",
				body: JSON.stringify({
					address: `${local.trim()}@${chosenDomain}`,
					displayName: displayName.trim(),
					...(owner.trim() ? { ownerEmail: owner.trim() } : {}),
				}),
			}),
		onSuccess: (m) => {
			toast(`Created ${m.address}.`);
			setLocal("");
			setDisplayName("");
			setOwner("");
			invalidate();
		},
		onError: (err) => toast.error(err.message),
	});
	const remove = useMutation({
		mutationFn: (id: string) => apiFetch(`/admin/mailboxes/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			toast("Mailbox removed.");
			invalidate();
		},
		onError: (err) => toast.error(err.message),
	});

	return (
		<Section title="Mailboxes" icon={Inbox}>
			<ul className="mb-6 divide-y rounded-lg border">
				{mailboxes?.length === 0 && <li className="text-muted-foreground p-3 text-sm">No mailboxes yet.</li>}
				{mailboxes?.map((m) => (
					<li key={m.id} className="text-sm">
						<div className="flex items-center gap-2 p-3">
							<button
								type="button"
								onClick={() => setOpen(open === m.id ? null : m.id)}
								className="flex flex-1 items-center gap-2 text-left"
								aria-expanded={open === m.id}
							>
								{open === m.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
								<span className="font-medium">{m.displayName}</span>
								<span className="text-muted-foreground">&lt;{m.address}&gt;</span>
							</button>
							<Button variant="ghost" size="sm" asChild>
								<Link to={`/mail/${m.id}/inbox`}>Open</Link>
							</Button>
							<Button variant="ghost" size="icon-sm" onClick={() => setDeleting(m)} aria-label={`Delete ${m.address}`}>
								<Trash2 className="size-4" />
							</Button>
						</div>
						{open === m.id && <Members mailbox={m} />}
					</li>
				))}
			</ul>

			<h3 className="mb-3 text-sm font-medium">New mailbox</h3>
			{domains?.length === 0 ? (
				<p className="text-muted-foreground text-sm">Add a domain first.</p>
			) : (
				<form
					className="grid gap-3 sm:grid-cols-2"
					onSubmit={(e) => {
						e.preventDefault();
						create.mutate();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mb-local">Address</Label>
						<div className="flex items-center gap-1">
							<Input id="mb-local" placeholder="hello" value={local} onChange={(e) => setLocal(e.target.value)} />
							<span className="text-muted-foreground">@</span>
							<select
								aria-label="Domain"
								value={chosenDomain}
								onChange={(e) => setDomain(e.target.value)}
								className="h-8 rounded-lg border bg-transparent px-2 text-sm"
							>
								{domains?.map((d) => (
									<option key={d.domain} value={d.domain}>
										{d.domain}
									</option>
								))}
							</select>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mb-name">Display name</Label>
						<Input id="mb-name" placeholder="Hello" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
					</div>
					<div className="flex flex-col gap-1.5 sm:col-span-2">
						<Label htmlFor="mb-owner">Owner (optional)</Label>
						<Input
							id="mb-owner"
							type="email"
							placeholder="person@company.com — the email they sign in with"
							value={owner}
							onChange={(e) => setOwner(e.target.value)}
						/>
					</div>
					<div className="sm:col-span-2">
						<Button type="submit" disabled={!local.trim() || !displayName.trim() || create.isPending}>
							<Plus className="size-4" /> Create mailbox
						</Button>
					</div>
				</form>
			)}

			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.address}?`}
				description="The address stops receiving mail and nobody can open it any more. Stored messages are not purged yet."
				confirmLabel="Delete mailbox"
				onConfirm={() => remove.mutate(deleting!.id)}
			/>
		</Section>
	);
}

function Members({ mailbox }: { mailbox: Mailbox }) {
	const queryClient = useQueryClient();
	const key = adminKeys.members(mailbox.id);
	const { data: members } = useQuery({ queryKey: key, queryFn: () => apiFetch<Member[]>(`/admin/mailboxes/${mailbox.id}/members`) });
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<MailboxRole>("member");
	const refresh = () => {
		queryClient.invalidateQueries({ queryKey: key });
		queryClient.invalidateQueries({ queryKey: queryKeys.me });
	};

	const save = useMutation({
		mutationFn: (m: { email: string; role: MailboxRole }) =>
			apiFetch(`/admin/mailboxes/${mailbox.id}/members`, { method: "PUT", body: JSON.stringify(m) }),
		onSuccess: () => {
			setEmail("");
			refresh();
		},
		onError: (err) => toast.error(err.message),
	});
	const remove = useMutation({
		mutationFn: (e: string) => apiFetch(`/admin/mailboxes/${mailbox.id}/members/${encodeURIComponent(e)}`, { method: "DELETE" }),
		onSuccess: refresh,
		onError: (err) => toast.error(err.message),
	});

	return (
		<div className="border-t bg-mail-canvas/50 px-9 py-3">
			<p className="text-muted-foreground mb-2 text-xs">People who can open this mailbox (admins always can).</p>
			<ul className="mb-3 flex flex-col gap-1">
				{members?.length === 0 && <li className="text-muted-foreground text-sm">Nobody yet.</li>}
				{members?.map((m) => (
					<li key={m.userEmail} className="flex items-center gap-2">
						<span className="flex-1 truncate">{m.userEmail}</span>
						<select
							aria-label={`Role for ${m.userEmail}`}
							value={m.role}
							onChange={(e) => save.mutate({ email: m.userEmail, role: e.target.value as MailboxRole })}
							className="h-7 rounded-md border bg-transparent px-1 text-xs"
						>
							<option value="member">Member</option>
							<option value="owner">Owner</option>
						</select>
						<Button variant="ghost" size="icon-xs" onClick={() => remove.mutate(m.userEmail)} aria-label={`Remove ${m.userEmail}`}>
							<Trash2 className="size-3.5" />
						</Button>
					</li>
				))}
			</ul>
			<form
				className="flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					save.mutate({ email: email.trim(), role });
				}}
			>
				<Input
					type="email"
					placeholder="person@company.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					aria-label="Email to add"
					className="h-7"
				/>
				<select
					aria-label="Role"
					value={role}
					onChange={(e) => setRole(e.target.value as MailboxRole)}
					className="h-7 rounded-md border bg-transparent px-1 text-xs"
				>
					<option value="member">Member</option>
					<option value="owner">Owner</option>
				</select>
				<Button type="submit" size="sm" disabled={!email.trim() || save.isPending}>
					<UserPlus className="size-3.5" /> Add
				</Button>
			</form>
		</div>
	);
}
