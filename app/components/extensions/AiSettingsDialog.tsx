import { ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProvider, type AiSettings, type AiSettingsUpdate } from "../../../shared/extensions";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { apiFetch } from "~/lib/api";
import { useAiModels, useAiSettings, useSaveAiSettings } from "~/lib/extensions";

const selectClass =
	"h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

/** Each user's own AI Assistant settings: on/off, provider, key and model. */
export function AiSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { data } = useAiSettings(open);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>AI Assistant</DialogTitle>
					<DialogDescription>
						Summarise conversations, draft replies, rewrite text and ask questions about your mail, using your own AI provider account. Your
						settings are yours alone; they apply in every mailbox you open.
					</DialogDescription>
				</DialogHeader>
				{data ? <AiSettingsForm key={String(open)} saved={data} onDone={() => onOpenChange(false)} /> : <Loader2 className="mx-auto my-8 animate-spin text-muted-foreground" />}
			</DialogContent>
		</Dialog>
	);
}

function AiSettingsForm({ saved, onDone }: { saved: AiSettings; onDone: () => void }) {
	const save = useSaveAiSettings();
	const [enabled, setEnabled] = useState(saved.enabled);
	const [provider, setProvider] = useState<AiProvider>(saved.provider);
	const [model, setModel] = useState(saved.model);
	const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [replacingKey, setReplacingKey] = useState(!saved.hasKey);
	const [removeKey, setRemoveKey] = useState(false);
	const [testing, setTesting] = useState(false);
	const ids = { provider: useId(), key: useId(), model: useId(), url: useId(), models: useId() };

	const p = AI_PROVIDERS[provider];
	const providerChanged = provider !== saved.provider;
	const keyStored = saved.hasKey && !providerChanged && !removeKey;
	const showKeyInput = !keyStored || replacingKey;
	// Models come from the provider with the saved key, so they're listed once settings are saved.
	const canListModels = !providerChanged && (provider === "workers-ai" || (p.needsBaseUrl ? !!saved.baseUrl : saved.hasKey));
	const models = useAiModels(canListModels);

	useEffect(() => {
		if (models.data?.length && !model) setModel(models.data[0]!.id);
	}, [models.data, model]);

	const keyMissing = p.needsKey && !keyStored && !apiKey.trim();
	const blocked = (p.needsKey || !!apiKey.trim()) && !saved.canStoreKeys && provider !== "workers-ai";

	const update = (): AiSettingsUpdate => ({
		enabled,
		...(providerChanged ? { provider } : {}),
		model: model.trim(),
		...(p.needsBaseUrl ? { baseUrl: baseUrl.trim() || null } : {}),
		...(apiKey.trim() ? { apiKey: apiKey.trim() } : removeKey && !providerChanged ? { apiKey: null } : {}),
	});

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			await save.mutateAsync(update());
			toast(enabled ? "AI Assistant is on." : "AI Assistant settings saved.");
			onDone();
		} catch (err) {
			toast.error(`Couldn't save: ${(err as Error).message}`);
		}
	};

	const test = async () => {
		setTesting(true);
		try {
			await save.mutateAsync(update());
			setApiKey("");
			setReplacingKey(false);
			setRemoveKey(false);
			const { reply } = await apiFetch<{ reply: string }>("/extensions/ai/test", { method: "POST", body: "{}" });
			toast.success(`It works. ${p.label} answered: "${reply || "(nothing)"}"`);
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			setTesting(false);
		}
	};

	return (
		<form onSubmit={submit} className="flex flex-col gap-5">
			<label className="flex items-center justify-between gap-4 rounded-lg border p-3">
				<span className="flex flex-col gap-0.5">
					<span className="text-sm font-medium">Turn on AI Assistant</span>
					<span className="text-xs text-muted-foreground">Adds AI buttons to conversations and the composer, and the Ask button in the top bar.</span>
				</span>
				<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Turn on AI Assistant" />
			</label>

			<div className="grid gap-2">
				<Label htmlFor={ids.provider}>Provider</Label>
				<select
					id={ids.provider}
					className={selectClass}
					value={provider}
					onChange={(e) => {
						const next = e.target.value as AiProvider;
						setProvider(next);
						setModel(next === saved.provider ? saved.model : AI_PROVIDERS[next].defaultModel);
						setBaseUrl(next === saved.provider ? (saved.baseUrl ?? "") : "");
						setApiKey("");
						setReplacingKey(next !== saved.provider || !saved.hasKey);
					}}
				>
					{AI_PROVIDER_IDS.map((id) => (
						<option key={id} value={id}>
							{AI_PROVIDERS[id].label}
						</option>
					))}
				</select>
				{provider === "openai-compatible" && (
					<p className="text-xs text-muted-foreground">Any server with an OpenAI-style API: OpenRouter, Groq, Together, Mistral, DeepSeek, or a local Ollama or LM Studio.</p>
				)}
				{provider === "workers-ai" && (
					<p className="text-xs text-muted-foreground">
						Runs on the Cloudflare account this mail server is deployed on, with no key of your own. Its usage is billed to that account.
					</p>
				)}
			</div>

			{p.needsBaseUrl && (
				<div className="grid gap-2">
					<Label htmlFor={ids.url}>Server URL</Label>
					<Input id={ids.url} type="url" required placeholder="https://openrouter.ai/api/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
				</div>
			)}

			{provider !== "workers-ai" && (
				<div className="grid gap-2">
					<div className="flex items-center justify-between">
						<Label htmlFor={ids.key}>API key{!p.needsKey && <span className="font-normal text-muted-foreground"> (optional)</span>}</Label>
						{p.keyUrl && (
							<a href={p.keyUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
								Get a key <ExternalLink className="size-3" aria-hidden />
							</a>
						)}
					</div>
					{keyStored && !replacingKey ? (
						<div className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
							<KeyRound className="size-4 text-muted-foreground" aria-hidden />
							<span className="flex-1">Saved key {saved.keyHint && <span className="font-mono text-muted-foreground">…{saved.keyHint}</span>}</span>
							<Button type="button" variant="ghost" size="sm" onClick={() => setReplacingKey(true)}>
								Replace
							</Button>
							<Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoveKey(true)}>
								Remove
							</Button>
						</div>
					) : (
						showKeyInput && (
							<Input
								id={ids.key}
								type="password"
								autoComplete="off"
								spellCheck={false}
								placeholder={keyStored ? "Enter a new key to replace the saved one" : p.keyPlaceholder}
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
							/>
						)
					)}
					{blocked ? (
						<p className="text-xs text-destructive">
							This server can't store API keys yet: an administrator needs to set the <code>ENCRYPTION_KEY</code> secret. Workers AI works without one.
						</p>
					) : (
						<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
							<ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
							Stored encrypted and only used for your requests. It's never shown again, here or anywhere else.
						</p>
					)}
				</div>
			)}

			<div className="grid gap-2">
				<div className="flex items-center justify-between">
					<Label htmlFor={ids.model}>Model</Label>
					{canListModels && (
						<button
							type="button"
							className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
							onClick={() => void models.refetch()}
							disabled={models.isFetching}
						>
							<RefreshCw className={models.isFetching ? "size-3 animate-spin" : "size-3"} aria-hidden /> Refresh list
						</button>
					)}
				</div>
				<Input
					id={ids.model}
					list={ids.models}
					required
					placeholder={provider === "openai-compatible" ? "e.g. meta-llama/llama-3.3-70b-instruct" : p.defaultModel}
					value={model}
					onChange={(e) => setModel(e.target.value)}
					spellCheck={false}
				/>
				<datalist id={ids.models}>
					{models.data?.map((m) => (
						<option key={m.id} value={m.id}>
							{m.name !== m.id ? m.name : undefined}
						</option>
					))}
				</datalist>
				<p className="text-xs text-muted-foreground">
					{models.isError
						? `Couldn't list models: ${models.error.message}`
						: models.data
							? `${models.data.length} models available; type to search.`
							: canListModels
								? "Loading the provider's models…"
								: "Save your key to see the provider's models, or type a model ID."}
				</p>
			</div>

			<p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
				Nothing runs on its own. When you click an AI button, the conversation or text it needs is sent to {p.label}
				{provider === "workers-ai" ? "" : " under your account, and their terms and privacy policy apply"}.
			</p>

			<DialogFooter className="gap-2">
				<Button type="button" variant="outline" onClick={() => void test()} disabled={testing || save.isPending || keyMissing || blocked || !model.trim()}>
					{testing && <Loader2 className="animate-spin" aria-hidden />}
					Test
				</Button>
				<Button type="submit" disabled={save.isPending || testing || (enabled && (keyMissing || blocked))}>
					{save.isPending && !testing && <Loader2 className="animate-spin" aria-hidden />}
					Save
				</Button>
			</DialogFooter>
		</form>
	);
}
