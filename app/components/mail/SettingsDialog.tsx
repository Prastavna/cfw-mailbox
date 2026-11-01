import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type FilterActions,
	type Label,
	type MailboxSettings,
	type MailFilter,
	UNDO_SEND_CHOICES,
	type VacationSettings,
} from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label as FieldLabel } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { apiFetch, queryKeys } from "~/lib/api";
import { settingsKey, useSettings } from "~/lib/compose-store";

export type SettingsTab = "general" | "vacation" | "filters";

interface SettingsDialogProps {
	mailboxId: string;
	address: string;
	labels: Label[] | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Tab to show when the dialog opens. */
	tab?: SettingsTab;
	/** Prefills the new-filter form (from "Create filter" in search). */
	filterQuery?: string;
}

const textareaClass =
	"w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const pad = (n: number) => String(n).padStart(2, "0");
const toDay = (ms: number | null) => {
	if (ms === null) return "";
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** First and last moment of a local calendar day. */
const dayStart = (day: string) => (day ? new Date(`${day}T00:00:00`).getTime() : null);
const dayEnd = (day: string) => (day ? new Date(`${day}T23:59:59.999`).getTime() : null);

const filtersKey = (mailboxId: string) => [...queryKeys.mailbox(mailboxId), "filters"] as const;

/** Per-mailbox settings: writing, the vacation responder and filters. */
export function SettingsDialog({ mailboxId, address, labels, open, onOpenChange, tab = "general", filterQuery }: SettingsDialogProps) {
	const { data } = useSettings(mailboxId);
	const queryClient = useQueryClient();
	const [current, setCurrent] = useState<SettingsTab>(tab);
	const [signature, setSignature] = useState("");
	const [undoSendSeconds, setUndoSendSeconds] = useState(5);
	const [vacation, setVacation] = useState<VacationSettings | null>(null);
	const [firstDay, setFirstDay] = useState("");
	const [lastDay, setLastDay] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (open) setCurrent(tab);
	}, [open, tab]);

	useEffect(() => {
		if (!open || !data) return;
		setSignature(data.signature);
		setUndoSendSeconds(data.undoSendSeconds);
		setVacation(data.vacation);
		setFirstDay(toDay(data.vacation.startAt));
		setLastDay(toDay(data.vacation.endAt));
	}, [open, data]);

	const vacationError =
		vacation?.enabled && !vacation.message.trim()
			? "Write a message to turn the responder on."
			: firstDay && lastDay && firstDay > lastDay
				? "The last day is before the first day."
				: null;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!vacation || vacationError) return;
		setSaving(true);
		try {
			const saved = await apiFetch<MailboxSettings>(`/mailboxes/${mailboxId}/settings`, {
				method: "PATCH",
				body: JSON.stringify({
					signature,
					undoSendSeconds,
					vacation: { ...vacation, startAt: dayStart(firstDay), endAt: dayEnd(lastDay) },
				}),
			});
			queryClient.setQueryData(settingsKey(mailboxId), saved);
			toast("Settings saved.");
			onOpenChange(false);
		} catch (err) {
			toast.error(`Couldn't save settings: ${(err as Error).message}`);
		} finally {
			setSaving(false);
		}
	};

	const setVac = <K extends keyof VacationSettings>(key: K, value: VacationSettings[K]) => setVacation((v) => (v ? { ...v, [key]: value } : v));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>For {address}. Everyone with access to this mailbox shares them.</DialogDescription>
				</DialogHeader>
				<Tabs value={current} onValueChange={(v) => setCurrent(v as SettingsTab)}>
					<TabsList>
						<TabsTrigger value="general">General</TabsTrigger>
						<TabsTrigger value="vacation">Vacation</TabsTrigger>
						<TabsTrigger value="filters">Filters</TabsTrigger>
					</TabsList>

					{current !== "filters" && (
						<form id="settings-form" onSubmit={submit} className="contents">
							<TabsContent value="general" className="grid gap-5 pt-3">
								<div className="grid gap-2">
									<FieldLabel htmlFor="signature">Signature</FieldLabel>
									<textarea
										id="signature"
										rows={5}
										maxLength={10_000}
										value={signature}
										onChange={(e) => setSignature(e.target.value)}
										placeholder={"Jane Doe\nExample Inc."}
										className={textareaClass}
									/>
									<p className="text-xs text-muted-foreground">Added below new messages and replies, after a "-- " line.</p>
								</div>
								<div className="grid gap-2">
									<FieldLabel htmlFor="undo-send">Undo send</FieldLabel>
									<div className="flex items-center gap-2 text-sm">
										<span>Send cancellation period:</span>
										<select
											id="undo-send"
											value={undoSendSeconds}
											onChange={(e) => setUndoSendSeconds(Number(e.target.value))}
											className="h-8 rounded-md border bg-transparent px-2 text-sm"
										>
											{UNDO_SEND_CHOICES.map((s) => (
												<option key={s} value={s}>
													{s === 0 ? "Off" : `${s} seconds`}
												</option>
											))}
										</select>
									</div>
								</div>
							</TabsContent>

							<TabsContent value="vacation" className="grid gap-4 pt-3">
								{vacation && (
									<>
										<label className="flex items-center justify-between gap-4 text-sm">
											<span>
												<span className="font-medium">Vacation responder</span>
												<span className="block text-xs text-muted-foreground">
													Replies automatically to people who write to you, at most once every 4 days each.
												</span>
											</span>
											<Switch checked={vacation.enabled} onCheckedChange={(c) => setVac("enabled", c)} aria-label="Vacation responder" />
										</label>
										<div className="grid gap-3 sm:grid-cols-2">
											<div className="grid gap-1.5">
												<FieldLabel htmlFor="vacation-first">First day</FieldLabel>
												<Input id="vacation-first" type="date" value={firstDay} onChange={(e) => setFirstDay(e.target.value)} />
											</div>
											<div className="grid gap-1.5">
												<FieldLabel htmlFor="vacation-last">Last day (optional)</FieldLabel>
												<Input id="vacation-last" type="date" value={lastDay} min={firstDay || undefined} onChange={(e) => setLastDay(e.target.value)} />
											</div>
										</div>
										<div className="grid gap-1.5">
											<FieldLabel htmlFor="vacation-subject">Subject</FieldLabel>
											<Input
												id="vacation-subject"
												maxLength={500}
												value={vacation.subject}
												placeholder="Re: their subject"
												onChange={(e) => setVac("subject", e.target.value)}
											/>
										</div>
										<div className="grid gap-1.5">
											<FieldLabel htmlFor="vacation-message">Message</FieldLabel>
											<textarea
												id="vacation-message"
												rows={6}
												maxLength={10_000}
												value={vacation.message}
												onChange={(e) => setVac("message", e.target.value)}
												placeholder="I'm away until Monday and will reply when I'm back."
												className={textareaClass}
											/>
										</div>
										<label className="flex items-center gap-2 text-sm">
											<Checkbox checked={vacation.contactsOnly} onCheckedChange={(c) => setVac("contactsOnly", c === true)} />
											Only send a response to people I've written to
										</label>
										{vacationError && (
											<p role="alert" className="text-sm text-destructive">
												{vacationError}
											</p>
										)}
									</>
								)}
							</TabsContent>
						</form>
					)}

					<TabsContent value="filters" className="pt-3">
						<FiltersPanel mailboxId={mailboxId} labels={labels} initialQuery={filterQuery} />
					</TabsContent>
				</Tabs>

				{current !== "filters" ? (
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" form="settings-form" disabled={saving || !data || !!vacationError}>
							Save changes
						</Button>
					</DialogFooter>
				) : (
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Close
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}

const NO_ACTIONS: FilterActions = { archive: false, markRead: false, star: false, important: false, trash: false, labelId: null };

function describeActions(a: FilterActions, labels: Label[] | undefined): string {
	const parts: string[] = [];
	if (a.archive) parts.push("Skip the Inbox");
	if (a.markRead) parts.push("Mark as read");
	if (a.star) parts.push("Star it");
	if (a.important) parts.push("Mark as important");
	if (a.labelId) parts.push(`Apply label "${labels?.find((l) => l.id === a.labelId)?.name ?? "deleted label"}"`);
	if (a.trash) parts.push("Delete it");
	return parts.join(", ");
}

function FiltersPanel({ mailboxId, labels, initialQuery }: { mailboxId: string; labels: Label[] | undefined; initialQuery?: string }) {
	const queryClient = useQueryClient();
	const filters = useQuery({
		queryKey: filtersKey(mailboxId),
		queryFn: () => apiFetch<MailFilter[]>(`/mailboxes/${mailboxId}/filters`),
	});
	const [query, setQuery] = useState(initialQuery ?? "");
	const [actions, setActions] = useState<FilterActions>(NO_ACTIONS);
	const [applyToExisting, setApplyToExisting] = useState(false);
	useEffect(() => {
		if (initialQuery !== undefined) setQuery(initialQuery);
	}, [initialQuery]);

	const userLabels = labels?.filter((l) => l.type === "user") ?? [];
	const anyAction = actions.archive || actions.markRead || actions.star || actions.important || actions.trash || !!actions.labelId;
	const set = <K extends keyof FilterActions>(key: K, value: FilterActions[K]) => setActions((a) => ({ ...a, [key]: value }));

	const create = useMutation({
		mutationFn: () =>
			apiFetch<{ filter: MailFilter; applied: number }>(`/mailboxes/${mailboxId}/filters`, {
				method: "POST",
				body: JSON.stringify({ query: query.trim(), actions, applyToExisting }),
			}),
		onSuccess: ({ applied }) => {
			toast(applyToExisting ? `Filter created and applied to ${applied} conversation${applied === 1 ? "" : "s"}.` : "Filter created.");
			setQuery("");
			setActions(NO_ACTIONS);
			setApplyToExisting(false);
			void queryClient.invalidateQueries({ queryKey: filtersKey(mailboxId) });
			if (applyToExisting) void queryClient.invalidateQueries({ queryKey: [...queryKeys.mailbox(mailboxId), "threads"] });
		},
		onError: (err) => toast.error(`Couldn't create the filter: ${err.message}`),
	});
	const remove = useMutation({
		mutationFn: (id: string) => apiFetch<void>(`/mailboxes/${mailboxId}/filters/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			toast("Filter deleted.");
			void queryClient.invalidateQueries({ queryKey: filtersKey(mailboxId) });
		},
		onError: (err) => toast.error(`Couldn't delete the filter: ${err.message}`),
	});

	return (
		<div className="grid gap-6">
			<section className="grid gap-2" aria-labelledby="filters-existing">
				<h3 id="filters-existing" className="text-sm font-medium">
					Filters for incoming mail
				</h3>
				{filters.isPending ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : filters.isError ? (
					<p className="text-sm text-destructive">Couldn't load filters: {filters.error.message}</p>
				) : filters.data.length === 0 ? (
					<p className="text-sm text-muted-foreground">No filters yet.</p>
				) : (
					<ul className="divide-y rounded-md border">
						{filters.data.map((f) => (
							<li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
								<div className="min-w-0 flex-1">
									<p className="truncate font-mono text-xs">{f.query}</p>
									<p className="truncate text-muted-foreground">{describeActions(f.actions, labels)}</p>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Delete filter ${f.query}`}
									disabled={remove.isPending}
									onClick={() => remove.mutate(f.id)}
								>
									<Trash2 className="size-4" />
								</Button>
							</li>
						))}
					</ul>
				)}
			</section>

			<form
				className="grid gap-3"
				aria-labelledby="filters-new"
				onSubmit={(e) => {
					e.preventDefault();
					if (query.trim() && anyAction) create.mutate();
				}}
			>
				<h3 id="filters-new" className="text-sm font-medium">
					Create a new filter
				</h3>
				<div className="grid gap-1.5">
					<FieldLabel htmlFor="filter-query">Matches</FieldLabel>
					<Input
						id="filter-query"
						value={query}
						maxLength={1000}
						placeholder="from:news@example.com has:attachment"
						className="font-mono text-xs"
						onChange={(e) => setQuery(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">Uses the same syntax as search. Applies to new mail as it arrives.</p>
				</div>
				<fieldset className="grid gap-2 text-sm">
					<legend className="mb-1 text-sm">When a message arrives that matches:</legend>
					{(
						[
							["archive", "Skip the Inbox (Archive it)"],
							["markRead", "Mark as read"],
							["star", "Star it"],
							["important", "Mark as important"],
							["trash", "Delete it"],
						] as const
					).map(([key, text]) => (
						<label key={key} className="flex items-center gap-2">
							<Checkbox checked={actions[key]} onCheckedChange={(c) => set(key, c === true)} />
							{text}
						</label>
					))}
					<label className="flex items-center gap-2">
						<Checkbox
							checked={!!actions.labelId}
							disabled={!userLabels.length}
							onCheckedChange={(c) => set("labelId", c === true ? (userLabels[0]?.id ?? null) : null)}
						/>
						Apply the label:
						<select
							aria-label="Label to apply"
							value={actions.labelId ?? ""}
							disabled={!userLabels.length}
							onChange={(e) => set("labelId", e.target.value || null)}
							className="h-7 rounded-md border bg-transparent px-2 text-sm"
						>
							<option value="">{userLabels.length ? "Choose label…" : "No labels yet"}</option>
							{userLabels.map((l) => (
								<option key={l.id} value={l.id}>
									{l.name}
								</option>
							))}
						</select>
					</label>
				</fieldset>
				<label className="flex items-center gap-2 text-sm">
					<Checkbox checked={applyToExisting} onCheckedChange={(c) => setApplyToExisting(c === true)} />
					Also apply filter to matching conversations
				</label>
				<div>
					<Button type="submit" disabled={!query.trim() || !anyAction || create.isPending}>
						Create filter
					</Button>
				</div>
			</form>
		</div>
	);
}
