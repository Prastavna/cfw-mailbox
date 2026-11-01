import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { Label, LabelInput } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label as FieldLabel } from "~/components/ui/label";
import { LABEL_COLORS } from "~/lib/folders";
import { cn } from "~/lib/utils";

interface LabelDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Edit this label; create a new one when omitted. */
	label?: Label;
	onSubmit: (input: LabelInput) => Promise<unknown>;
}

export function LabelDialog({ open, onOpenChange, label, onSubmit }: LabelDialogProps) {
	const [name, setName] = useState("");
	const [color, setColor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setName(label?.name ?? "");
		setColor(label?.color ?? null);
		setError(null);
	}, [open, label]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		try {
			await onSubmit({ name: name.trim(), color });
			onOpenChange(false);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{label ? "Edit label" : "New label"}</DialogTitle>
						<DialogDescription className="sr-only">Choose a name and colour for the label.</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-2">
						<FieldLabel htmlFor="label-name">Label name</FieldLabel>
						<Input
							id="label-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={100}
							autoFocus
							aria-invalid={!!error}
						/>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</div>
					<fieldset className="flex flex-col gap-2">
						<legend className="mb-2 text-sm font-medium">Colour</legend>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => setColor(null)}
								className={cn("flex size-7 items-center justify-center rounded-full border text-xs", color === null && "ring-2 ring-ring")}
								aria-label="No colour"
								aria-pressed={color === null}
							>
								{color === null && <Check className="size-3.5" />}
							</button>
							{LABEL_COLORS.map((c) => (
								<button
									key={c}
									type="button"
									onClick={() => setColor(c)}
									className={cn("flex size-7 items-center justify-center rounded-full", color === c && "ring-2 ring-ring ring-offset-2")}
									style={{ backgroundColor: c }}
									aria-label={`Colour ${c}`}
									aria-pressed={color === c}
								>
									{color === c && <Check className="size-3.5 text-white" />}
								</button>
							))}
						</div>
					</fieldset>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!name.trim() || saving}>
							{label ? "Save" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: React.ReactNode;
	confirmLabel: string;
	onConfirm: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => {
							onOpenChange(false);
							onConfirm();
						}}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
