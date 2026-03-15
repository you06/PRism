// ---------------------------------------------------------------------------
// PRism Local Daemon — entry point
//
// Standalone daemon startup. For CLI usage, see cli.ts.
// ---------------------------------------------------------------------------

import { createDaemon, startDaemon } from "./server.js";

const daemon = createDaemon();
startDaemon(daemon);
