// ---------------------------------------------------------------------------
// PRism daemon — configuration loading
//
// Config dir is fixed at ~/.config/prism
// Config file: config.json
// Pairing secret: pairing-secret (separate file, restricted permissions)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DAEMON_DEFAULT_PORT } from "@prism/shared";

/** Resolved daemon configuration. */
export interface DaemonConfig {
  host: string;
  port: number;
  configDir: string;
}

const DEFAULT_HOST = "127.0.0.1";

/** Return the PRism config directory (~/.config/prism), creating it if necessary. */
export function getConfigDir(): string {
  const dir = path.join(os.homedir(), ".config", "prism");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Load config from disk, falling back to defaults for missing fields. */
export function loadConfig(): DaemonConfig {
  const configDir = getConfigDir();
  const configPath = path.join(configDir, "config.json");

  let fileConfig: Partial<{ host: string; port: number }> = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw);
    } catch (err) {
      console.warn(`PRism: failed to parse ${configPath}, using defaults`, err);
    }
  }

  // Environment overrides take highest precedence
  const host = process.env["PRISM_HOST"] || fileConfig.host || DEFAULT_HOST;
  const port = Number(process.env["PRISM_PORT"]) || fileConfig.port || DAEMON_DEFAULT_PORT;

  return { host, port, configDir };
}
