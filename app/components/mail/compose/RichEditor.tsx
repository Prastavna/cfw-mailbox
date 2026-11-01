import { Placeholder } from "@tiptap/extensions";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	Bold,
	Italic,
	Link2,
	List,
	ListOrdered,
	Quote,
	Redo2,
	RemoveFormatting,
	Strikethrough,
	Underline,
	Undo2,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface RichEditorProps {
	initialHtml: string;
	onChange: (editor: Editor) => void;
	onReady: (editor: Editor) => void;
	onSubmit: () => void;
	autoFocus?: boolean;
	className?: string;
}

/** The message body editor. Content is HTML; only formatting that survives email clients is offered. */
export function RichEditor({ initialHtml, onChange, onReady, onSubmit, autoFocus, className }: RichEditorProps) {
	const editor = useEditor({
		immediatelyRender: false,
		shouldRerenderOnTransaction: true,
		extensions: [
			StarterKit.configure({
				heading: false,
				codeBlock: false,
				horizontalRule: false,
				link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
			}),
			Placeholder.configure({ placeholder: "" }),
		],
		content: initialHtml,
		autofocus: autoFocus ? "start" : false,
		editorProps: {
			attributes: {
				class: "prose-mail min-h-full px-4 py-2 text-sm outline-none",
				"aria-label": "Message body",
				role: "textbox",
				"aria-multiline": "true",
			},
			handleKeyDown: (_view, event) => {
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
					onSubmit();
					return true;
				}
				return false;
			},
		},
		onCreate: ({ editor }) => onReady(editor),
		onUpdate: ({ editor }) => onChange(editor),
	});

	return <EditorContent editor={editor} className={cn("min-h-0 flex-1 cursor-text overflow-y-auto", className)} />;
}

function ToolButton({
	label,
	active,
	onClick,
	disabled,
	children,
}: {
	label: string;
	active?: boolean;
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={label}
					aria-pressed={active}
					disabled={disabled}
					onMouseDown={(e) => e.preventDefault()}
					onClick={onClick}
					className={cn("rounded-sm", active && "bg-mail-active text-mail-active-foreground")}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

export function FormattingToolbar({ editor }: { editor: Editor | null }) {
	if (!editor) return null;
	const chain = () => editor.chain().focus();
	const setLink = () => {
		const previous = editor.getAttributes("link").href as string | undefined;
		const url = window.prompt("Link address", previous ?? "https://");
		if (url === null) return;
		if (!url.trim() || url.trim() === "https://") return chain().extendMarkRange("link").unsetLink().run();
		const href = /^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
		chain().extendMarkRange("link").setLink({ href }).run();
	};
	return (
		<div role="toolbar" aria-label="Formatting" className="mx-3 mb-1 flex flex-wrap items-center gap-0.5 rounded-md border bg-muted/40 px-1 py-0.5 shadow-xs">
			<ToolButton label="Undo (Ctrl+Z)" onClick={() => chain().undo().run()} disabled={!editor.can().undo()}>
				<Undo2 />
			</ToolButton>
			<ToolButton label="Redo (Ctrl+Y)" onClick={() => chain().redo().run()} disabled={!editor.can().redo()}>
				<Redo2 />
			</ToolButton>
			<span className="mx-1 h-5 w-px bg-border" aria-hidden />
			<ToolButton label="Bold (Ctrl+B)" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}>
				<Bold />
			</ToolButton>
			<ToolButton label="Italic (Ctrl+I)" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}>
				<Italic />
			</ToolButton>
			<ToolButton label="Underline (Ctrl+U)" active={editor.isActive("underline")} onClick={() => chain().toggleUnderline().run()}>
				<Underline />
			</ToolButton>
			<ToolButton label="Strikethrough" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}>
				<Strikethrough />
			</ToolButton>
			<span className="mx-1 h-5 w-px bg-border" aria-hidden />
			<ToolButton label="Insert link" active={editor.isActive("link")} onClick={setLink}>
				<Link2 />
			</ToolButton>
			<ToolButton label="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}>
				<ListOrdered />
			</ToolButton>
			<ToolButton label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}>
				<List />
			</ToolButton>
			<ToolButton label="Quote" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}>
				<Quote />
			</ToolButton>
			<ToolButton label="Remove formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}>
				<RemoveFormatting />
			</ToolButton>
		</div>
	);
}
