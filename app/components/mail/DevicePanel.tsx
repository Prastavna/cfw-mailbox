import { BellRing, Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { setOfflineMail, swSupported, syncOfflineMail, useInstallPrompt, useOfflineMail, usePush } from "~/lib/pwa";

/** Settings that belong to this browser, not the mailbox: notifications, offline mail, install. */
export function DevicePanel({ mailboxId, address }: { mailboxId: string; address: string }) {
	return (
		<div className="grid gap-6 pt-3">
			<p className="text-xs text-muted-foreground">These settings are yours alone and only apply to this browser.</p>
			<NotificationsSection mailboxId={mailboxId} address={address} />
			<OfflineSection mailboxId={mailboxId} />
			<InstallSection />
		</div>
	);
}

function Row({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-4 text-sm">
			<div>
				<div className="font-medium">{title}</div>
				<div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
			</div>
			<div className="shrink-0 pt-0.5">{children}</div>
		</div>
	);
}

function NotificationsSection({ mailboxId, address }: { mailboxId: string; address: string }) {
	const push = usePush(mailboxId);
	const [testing, setTesting] = useState(false);

	const unavailable = !push.support.ok
		? push.support.reason === "install-first"
			? "On iPhone and iPad, add Mail to your Home Screen (Share → Add to Home Screen) and open it from there to turn notifications on."
			: push.support.reason === "insecure"
				? "Notifications need the app to be served over HTTPS."
				: "This browser doesn't support web notifications."
		: push.permission === "denied"
			? "Notifications are blocked for this site. Allow them in your browser's site settings, then come back."
			: null;

	const toggle = async (on: boolean) => {
		try {
			await push.setEnabled(on);
			toast(on ? `You'll be notified about new mail for ${address}.` : "Notifications turned off.");
		} catch (err) {
			toast.error((err as Error).message);
		}
	};

	const test = async () => {
		setTesting(true);
		try {
			await push.sendTest();
			toast("Test notification sent.");
		} catch (err) {
			toast.error(`Couldn't send a test notification: ${(err as Error).message}`);
		} finally {
			setTesting(false);
		}
	};

	return (
		<section className="grid gap-2" aria-label="Notifications">
			<Row title="New mail notifications" description={unavailable ?? `When a message arrives in ${address}'s Inbox, even with Mail closed.`}>
				<Switch
					checked={!!push.enabled}
					disabled={!!unavailable || push.enabled === null || push.busy}
					onCheckedChange={(c) => void toggle(c)}
					aria-label="New mail notifications"
				/>
			</Row>
			{push.enabled && (
				<div>
					<Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={testing}>
						<BellRing aria-hidden /> Send a test notification
					</Button>
				</div>
			)}
		</section>
	);
}

function OfflineSection({ mailboxId }: { mailboxId: string }) {
	const enabled = useOfflineMail();
	const [busy, setBusy] = useState(false);
	const supported = swSupported();

	const toggle = async (on: boolean) => {
		setBusy(true);
		try {
			await setOfflineMail(on);
			if (on) {
				const saved = await syncOfflineMail(mailboxId, new AbortController().signal);
				toast(`Offline mail is on. ${saved} conversation${saved === 1 ? "" : "s"} saved on this device.`);
			} else toast("Offline mail is off. Mail saved on this device was deleted.");
		} catch (err) {
			toast.error(`Couldn't change offline mail: ${(err as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Row
			title="Offline mail"
			description={
				supported
					? "Keeps your newest Inbox conversations, and those you open, on this device so you can read them without a connection. Don't turn this on for a shared computer."
					: "This browser can't keep mail for offline reading."
			}
		>
			<Switch checked={enabled} disabled={!supported || busy} onCheckedChange={(c) => void toggle(c)} aria-label="Offline mail" />
		</Row>
	);
}

function InstallSection() {
	const install = useInstallPrompt();
	if (!install) return null;
	return (
		<Row title="Install Mail" description="Open Mail in its own window, from your dock, taskbar or home screen.">
			<Button type="button" variant="outline" size="sm" onClick={() => void install()}>
				<Download aria-hidden /> Install
			</Button>
		</Row>
	);
}
