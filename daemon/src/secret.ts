// ---------------------------------------------------------------------------
// PRism daemon — pairing secret management
//
// The pairing secret authenticates the Chrome extension to the daemon.
// It is a 64-char hex token stored at <configDir>/pairing-secret with
// mode 0600. On first start the daemon generates one automatically.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SECRET_FILENAME = "pairing-secret";
const SECRET_BYTES = 32; // 256-bit → 64 hex chars

/** Ensure a pairing secret exists, generating one if needed. Returns the secret. */
export function ensurePairingSecret(configDir: string): string {
  const secretPath = path.join(configDir, SECRET_FILENAME);

  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, "utf-8").trim();
    if (existing.length > 0) {
      return existing;
    }
  }

  const secret = crypto.randomBytes(SECRET_BYTES).toString("hex");
  fs.writeFileSync(secretPath, secret + "\n", { mode: 0o600 });
  console.log(`PRism: generated pairing secret → ${secretPath}`);
  return secret;
}
