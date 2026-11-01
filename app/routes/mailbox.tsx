import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { AskInbox } from "~/components/extensions/ai/AskInbox";
import { AiSettingsDialog } from "~/components/extensions/AiSettingsDialog";
import { ComposeDock } from "~/components/mail/compose/ComposeWindow";
import { Header } from "~/components/mail/Header";
import { SettingsDialog, type SettingsTab } from "~/components/mail/SettingsDialog";
import { ShortcutsHelp } from "~/components/mail/ShortcutsHelp";
import { VacationBanner } from "~/components/mail/VacationBanner";
import { Sidebar } from "~/components/mail/Sidebar";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useMediaQuery } from "~/hooks/use-media-query";
import type { MailboxAccess, Me } from "../../shared/api";
import { useMailActions } from "~/lib/actions";
import { rememberMailbox, useLabels, useMailboxEvents, useMe } from "~/lib/api";
import { useComposer } from "~/lib/compose-store";
import { useAiReady } from "~/lib/extensions";
import type { MailboxContext } from "~/lib/mailbox-context";
import { useShortcuts } from "~/lib/shortcuts";
import { cn } from "~/lib/utils";

const COLLAPSED_KEY = "cfw-mailbox:sidebar-collapsed";

/** Gmail-style frame: header, folder sidebar and the main panel, for one mailbox. */
export default function MailboxLayout() {
	const { mailboxId = "" } = useParams();
	const { data: me, isPending, error } = useMe();
	const mailbox = me?.mailboxes.find((m) => m.id === mailboxId);

	if (isPending) return <div className="min-h-svh bg-mail-canvas" aria-busy />;
	if (error) return <FullPageMessage>Couldn't sign you in: {error.message}</FullPageMessage>;
	if (!mailbox) {
		return (
			<FullPageMessage>
				This mailbox doesn't exist or you don't have access to it.{" "}
				<Link to="/" className="text-primary underline">
					Go to your mail
				</Link>
			</FullPageMessage>
		);
	}
	return <MailboxFrame key={mailbox.id} me={me!} mailbox={mailbox} />;
}

function MailboxFrame({ me, mailbox }: { me: Me; mailbox: MailboxAccess }) {
	const { data: labels } = useLabels(mailbox.id);
	const actions = useMailActions(mailbox.id);
	const composer = useComposer(mailbox);
	const live = useMailboxEvents(mailbox.id, composer);
	const desktop = useMediaQuery("(min-width: 768px)");
	const [collapsed, setCollapsed] = useState(false);
	const [mobileOpen, setMobileOpen] = useState(false);
	const location = useLocation();
	const [settings, setSettings] = useState<{ open: boolean; tab: SettingsTab; filterQuery?: string }>({ open: false, tab: "general" });
	const openSettings = (tab: SettingsTab = "general", filterQuery?: string) => setSettings({ open: true, tab, filterQuery });
	const [helpOpen, setHelpOpen] = useState(false);
	const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
	const [askOpen, setAskOpen] = useState(false);
	const aiReady = useAiReady();
	const navigate = useNavigate();
	const go = (slug: string) => () => navigate(`/mail/${mailbox.id}/${slug}`);
	useShortcuts({
		c: () => composer.compose(),
		"/": () => document.querySelector<HTMLInputElement>('input[aria-label="Search mail"]')?.focus(),
		"?": () => setHelpOpen(true),
		"g i": go("inbox"),
		"g s": go("starred"),
		"g t": go("sent"),
		"g d": go("drafts"),
		"g a": go("all"),
	});

	useEffect(() => rememberMailbox(mailbox.id), [mailbox.id]);
	useEffect(() => {
		try {
			setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
		} catch {
			// Storage unavailable; default to expanded.
		}
	}, []);
	useEffect(() => setMobileOpen(false), [location.pathname]);

	const toggleSidebar = () => {
		if (!desktop) return setMobileOpen((v) => !v);
		setCollapsed((v) => {
			try {
				localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
			} catch {
				// Not important.
			}
			return !v;
		});
	};

	return (
		<TooltipProvider delayDuration={400}>
			<div className="flex h-svh flex-col bg-mail-canvas text-foreground">
				<Header
					me={me}
					mailbox={mailbox}
					live={live}
					labels={labels}
					onToggleSidebar={toggleSidebar}
					onOpenSettings={openSettings}
					onOpenExtension={() => setAiSettingsOpen(true)}
					onAsk={aiReady ? () => setAskOpen(true) : undefined}
				/>
				<VacationBanner mailboxId={mailbox.id} onOpenSettings={() => openSettings("vacation")} />
				<div className="flex min-h-0 flex-1">
					<aside className={cn("hidden shrink-0 overflow-y-auto md:block", collapsed ? "w-[72px]" : "w-64")}>
						<Sidebar mailboxId={mailbox.id} labels={labels} collapsed={collapsed} actions={actions} onCompose={() => composer.compose()} />
					</aside>
					<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
						<SheetContent side="left" className="w-72 bg-mail-canvas p-0 pt-4">
							<SheetTitle className="sr-only">Folders</SheetTitle>
							<Sidebar
								mailboxId={mailbox.id}
								labels={labels}
								collapsed={false}
								actions={actions}
								onNavigate={() => setMobileOpen(false)}
								onCompose={() => {
									setMobileOpen(false);
									composer.compose();
								}}
							/>
						</SheetContent>
					</Sheet>
					<main className="mb-0 min-w-0 flex-1 overflow-hidden bg-mail-surface md:mr-4 md:mb-4 md:rounded-2xl">
						<Outlet context={{ me, mailbox, labels, actions, composer } satisfies MailboxContext} />
					</main>
				</div>
				{/* Phones have no sidebar on screen; Compose floats over the list, as in Gmail's app. */}
				<Button
					className="fixed right-4 bottom-5 z-20 h-14 rounded-2xl bg-mail-compose px-5 text-mail-active-foreground shadow-lg hover:bg-mail-compose/90 md:hidden"
					onClick={() => composer.compose()}
				>
					<Pencil aria-hidden /> Compose
				</Button>
				<ComposeDock mailbox={mailbox} />
				<ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
				<AiSettingsDialog open={aiSettingsOpen} onOpenChange={setAiSettingsOpen} />
				{aiReady && <AskInbox mailboxId={mailbox.id} open={askOpen} onOpenChange={setAskOpen} />}
				<SettingsDialog
					mailboxId={mailbox.id}
					address={mailbox.address}
					labels={labels}
					open={settings.open}
					tab={settings.tab}
					filterQuery={settings.filterQuery}
					onOpenChange={(open) => setSettings((s) => ({ ...s, open }))}
				/>
			</div>
		</TooltipProvider>
	);
}

function FullPageMessage({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-svh items-center justify-center bg-mail-canvas p-6">
			<p className="max-w-md text-center text-sm">{children}</p>
		</div>
	);
}
