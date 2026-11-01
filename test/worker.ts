// Test entry: the real Worker minus the React Router build, which only exists under Vite.
import { createWorker } from "../workers/index";

export { MailboxDO, RegistryDO } from "../workers/index";

export default createWorker(() => new Response("Not found", { status: 404 }));
