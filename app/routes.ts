import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("admin", "routes/admin.tsx"),
	route("mail/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("contacts", "routes/contacts.tsx"),
		route(":folder", "routes/folder.tsx"),
		route(":folder/:threadId", "routes/thread.tsx"),
	]),
] satisfies RouteConfig;
