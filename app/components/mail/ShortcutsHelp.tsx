import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { SHORTCUT_HELP, setShortcutsEnabled, useShortcutsEnabled } from "~/lib/shortcuts";

export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const enabled = useShortcutsEnabled();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>Single keys, like Gmail. They don't fire while you're typing.</DialogDescription>
				</DialogHeader>
				<label className="flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm">
					<span>
						Keyboard shortcuts {enabled ? "on" : "off"}
						<span className="block text-xs text-muted-foreground">Saved in this browser. "?" always opens this list.</span>
					</span>
					<Switch checked={enabled} onCheckedChange={setShortcutsEnabled} aria-label="Keyboard shortcuts" />
				</label>
				<div className="grid gap-6 sm:grid-cols-2">
					{SHORTCUT_HELP.map((group) => (
						<section key={group.section} className={group.section === "Actions" ? "sm:row-span-2" : undefined}>
							<h3 className="mb-2 text-sm font-medium">{group.section}</h3>
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
								{group.items.map(([keys, description]) => (
									<div key={keys} className="contents">
										<dt>
											<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">{keys}</kbd>
										</dt>
										<dd className="text-muted-foreground">{description}</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
