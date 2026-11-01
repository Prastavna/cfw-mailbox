import { createRequestHandler } from "react-router";
import { createWorker } from "./index";

export { MailboxDO, RegistryDO } from "./index";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default createWorker((request) => requestHandler(request));
