import { createLogger } from "@shared/logger";

// Headless instances (spawned by the manager) all write to the same file, so
// tag their lines with the share port as well as the pid
const portArg = process.argv.find((a) => a.startsWith("--port="))?.slice(7);
const tag = process.argv.includes("--headless") && portArg
  ? `pid ${process.pid} :${portArg}`
  : `pid ${process.pid}`;

export const logger = createLogger("share", tag);
