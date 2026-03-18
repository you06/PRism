// ---------------------------------------------------------------------------
// PRism Local Daemon — entry point
//
// Standalone daemon startup. For CLI usage, see cli.ts.
// ---------------------------------------------------------------------------

import { createDaemon, startDaemon, shutdownDaemon } from "./server.js";

const daemon = createDaemon();
await startDaemon(daemon);

const shutdown = async () => {
  await shutdownDaemon(daemon);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
