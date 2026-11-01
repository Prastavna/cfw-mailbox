import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type MailboxSettings, UNDO_SEND_CHOICES } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Label as FieldLabel } from "~/components/ui/label";
import { apiFetch } from "~/lib/api";
import { settingsKey, useSettings } from "~/lib/compose-store";

interface SettingsDialogProps {
	mailboxId: string;
	address: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** Per-mailbox settings for writing mail: signature and the undo-send window. */
export function SettingsDialog({ mailboxId, address, open, onOpenChange }: SettingsDialogProps) {
	const { data } = useSettings(mailboxId);
	const queryClient = useQueryClient();
	const [signature, setSignature] = useState("");
	const [undoSendSeconds, setUndoSendSeconds] = useState(5);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open || !data) return;
		setSignature(data.signature);
		setUndoSendSeconds(data.undoSendSeconds);
	}, [open, data]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		try {
			const saved = await apiFetch<MailboxSettings>(`/mailboxes/${mailboxId}/settings`, {
				method: "PATCH",
				body: JSON.stringify({ signature, undoSendSeconds }),
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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="grid gap-5">
					<DialogHeader>
						<DialogTitle>Settings</DialogTitle>
						<DialogDescription>For {address}. Everyone with access to this mailbox shares them.</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<FieldLabel htmlFor="signature">Signature</FieldLabel>
						<textarea
							id="signature"
							rows={5}
							maxLength={10_000}
							value={signature}
							onChange={(e) => setSignature(e.target.value)}
							placeholder={"Jane Doe\nExample Inc."}
							className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={saving || !data}>
							Save changes
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
