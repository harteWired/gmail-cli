// Configuration + credential resolution for gmail-cli.
//
// Credentials (OAuth client id/secret + refresh token) resolve in priority
// order:
//   1. Environment variables (GMAIL_CLI_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN)
//   2. Config file JSON (default ~/.config/gmail-cli/config.json, override with
//      $GMAIL_CLI_CONFIG)
//
// The short-lived access token is cached next to the config file.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync,
} from 'node:fs';

// Paths are resolved lazily (read env at call time) so overrides and tests work.
export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'gmail-cli');
}
export function configPath() {
  return process.env.GMAIL_CLI_CONFIG || join(configDir(), 'config.json');
}
export function tokenPath() {
  return join(configDir(), 'token.json');
}

function ensureDir() {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

// Merge a patch into the config file and persist it (mode 600 — holds secrets).
export function saveConfig(patch) {
  ensureDir();
  const merged = { ...loadConfig(), ...patch };
  const path = configPath();
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  if (existsSync(path)) chmodSync(path, 0o600);
  return merged;
}

// Resolve { clientId, clientSecret, refreshToken }. `requireToken=false` skips
// the refresh-token requirement (used by `gmail auth`, which is minting one).
export function resolveCreds({ requireToken = true } = {}) {
  const file = loadConfig();
  const clientId = process.env.GMAIL_CLI_CLIENT_ID || file.client_id;
  const clientSecret = process.env.GMAIL_CLI_CLIENT_SECRET || file.client_secret;
  const refreshToken = process.env.GMAIL_CLI_REFRESH_TOKEN || file.refresh_token;

  if (!clientId || !clientSecret) {
    throw new Error(
      'no OAuth client configured. Set GMAIL_CLI_CLIENT_ID / GMAIL_CLI_CLIENT_SECRET, ' +
      `or add client_id / client_secret to ${configPath()}. See README "Setup".`
    );
  }
  if (requireToken && !refreshToken) {
    throw new Error(
      'not authenticated. Run `gmail auth` to sign in, or set GMAIL_CLI_REFRESH_TOKEN. ' +
      'See README "Authentication".'
    );
  }
  return { clientId, clientSecret, refreshToken };
}

export function readTokenCache() {
  try {
    return JSON.parse(readFileSync(tokenPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTokenCache(obj) {
  ensureDir();
  const path = tokenPath();
  writeFileSync(path, JSON.stringify(obj), { mode: 0o600 });
  if (existsSync(path)) chmodSync(path, 0o600);
}
