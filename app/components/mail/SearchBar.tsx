import { Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { Label } from "../../../shared/api";
import { buildSearchQuery, EMPTY_SEARCH_FIELDS, type SearchFields, searchFieldsFrom } from "../../../shared/search";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label as FieldLabel } from "~/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { SEARCH_SEGMENT } from "~/lib/folders";

const WITHIN = [
	["", "Any time"],
	["1d", "1 day"],
	["3d", "3 days"],
	["7d", "1 week"],
	["14d", "2 weeks"],
	["1m", "1 month"],
	["2m", "2 months"],
	["6m", "6 months"],
	["1y", "1 year"],
] as const;

const FOLDERS = [
	["", "All Mail"],
	["inbox", "Inbox"],
	["starred", "Starred"],
	["sent", "Sent Mail"],
	["drafts", "Drafts"],
	["spam", "Spam"],
	["trash", "Trash"],
	["anywhere", "Mail & Spam & Trash"],
] as const;

/** Gmail-style search box with an advanced-search panel. Searches go to /mail/:id/search?q=… */
export function SearchBar({ mailboxId, labels }: { mailboxId: string; labels: Label[] | undefined }) {
	const navigate = useNavigate();
	const { folder } = useParams();
	const [params] = useSearchParams();
	const current = folder === SEARCH_SEGMENT ? (params.get("q") ?? "") : "";
	const [text, setText] = useState(current);
	const [advanced, setAdvanced] = useState(false);
	const [fields, setFields] = useState<SearchFields>(EMPTY_SEARCH_FIELDS);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => setText(current), [current]);

	const run = (query: string) => {
		const q = query.trim();
		if (!q) return;
		setAdvanced(false);
		inputRef.current?.blur();
		navigate(`/mail/${mailboxId}/${SEARCH_SEGMENT}?q=${encodeURIComponent(q)}`);
	};

	const openAdvanced = () => {
		setFields(searchFieldsFrom(text));
		setAdvanced(true);
	};
	const set = <K extends keyof SearchFields>(key: K, value: SearchFields[K]) => setFields((f) => ({ ...f, [key]: value }));
	const userLabels = labels?.filter((l) => l.type === "user") ?? [];

	return (
		<Popover open={advanced} onOpenChange={setAdvanced}>
			<PopoverAnchor asChild>
				<form
					role="search"
					className="flex h-12 w-full max-w-[720px] items-center gap-1 rounded-full bg-mail-hover/70 px-1 focus-within:bg-mail-surface focus-within:shadow-[0_1px_1px_0_rgba(65,69,73,.3),0_1px_3px_1px_rgba(65,69,73,.15)] dark:bg-mail-surface"
					onSubmit={(e) => {
						e.preventDefault();
						run(text);
					}}
				>
					<Button type="submit" variant="ghost" size="icon" className="rounded-full" aria-label="Search">
						<Search className="size-5" />
					</Button>
					<input
						ref={inputRef}
						type="search"
						aria-label="Search mail"
						placeholder="Search mail"
						autoComplete="off"
						spellCheck={false}
						className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								setText(current);
								inputRef.current?.blur();
							}
						}}
					/>
					{text && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="rounded-full"
							aria-label="Clear search"
							onClick={() => {
								setText("");
								if (current) navigate(`/mail/${mailboxId}/inbox`);
								else inputRef.current?.focus();
							}}
						>
							<X className="size-5" />
						</Button>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="hidden rounded-full sm:inline-flex"
								aria-label="Show search options"
								onClick={openAdvanced}
							>
								<SlidersHorizontal className="size-5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Show search options</TooltipContent>
					</Tooltip>
				</form>
			</PopoverAnchor>
			<PopoverContent align="start" className="w-[min(720px,calc(100vw-16px))] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
				<form
					aria-label="Search options"
					className="grid gap-3 p-5"
					onSubmit={(e) => {
						e.preventDefault();
						run(buildSearchQuery(fields));
					}}
				>
					{(
						[
							["from", "From"],
							["to", "To"],
							["subject", "Subject"],
							["hasWords", "Has the words"],
							["doesntHave", "Doesn't have"],
						] as const
					).map(([key, label]) => (
						<div key={key} className="grid grid-cols-[120px_1fr] items-center gap-3">
							<FieldLabel htmlFor={`search-${key}`} className="font-normal">
								{label}
							</FieldLabel>
							<Input
								id={`search-${key}`}
								value={fields[key]}
								onChange={(e) => set(key, e.target.value)}
								className="h-8 rounded-none border-0 border-b px-0 shadow-none focus-visible:ring-0"
							/>
						</div>
					))}
					<div className="grid grid-cols-[120px_1fr] items-center gap-3">
						<FieldLabel htmlFor="search-within" className="font-normal">
							Date within
						</FieldLabel>
						<select
							id="search-within"
							value={fields.within}
							onChange={(e) => set("within", e.target.value)}
							className="h-8 w-48 rounded-md border bg-transparent px-2 text-sm"
						>
							{WITHIN.map(([v, l]) => (
								<option key={v} value={v}>
									{l}
								</option>
							))}
						</select>
					</div>
					<div className="grid grid-cols-[120px_1fr] items-center gap-3">
						<FieldLabel htmlFor="search-in" className="font-normal">
							Search
						</FieldLabel>
						<select
							id="search-in"
							value={fields.folder}
							onChange={(e) => set("folder", e.target.value)}
							className="h-8 w-48 rounded-md border bg-transparent px-2 text-sm"
						>
							{FOLDERS.map(([v, l]) => (
								<option key={v} value={v}>
									{l}
								</option>
							))}
							{userLabels.map((l) => (
								<option key={l.id} value={l.name}>
									{l.name}
								</option>
							))}
						</select>
					</div>
					<label className="flex items-center gap-2 text-sm">
						<Checkbox checked={fields.hasAttachment} onCheckedChange={(c) => set("hasAttachment", c === true)} />
						Has attachment
					</label>
					<div className="flex justify-end gap-2 pt-2">
						<Button type="button" variant="ghost" onClick={() => setFields(EMPTY_SEARCH_FIELDS)}>
							Clear filter
						</Button>
						<Button type="submit" className="rounded-md px-6" disabled={!buildSearchQuery(fields)}>
							Search
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}
