import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  resolveCreds, saveAccount, loadConfig, configPath,
  setAccount, activeAccount, listAccounts,
} from '../lib/config.js';

// Isolate every test: fresh temp config file, clear cred env, reset active account.
beforeEach(() => {
  process.env.GMAIL_CLI_CONFIG = join(tmpdir(), `gmail-cli-test-${process.pid}-${process.hrtime()[1]}.json`);
  delete process.env.GMAIL_CLI_CLIENT_ID;
  delete process.env.GMAIL_CLI_CLIENT_SECRET;
  delete process.env.GMAIL_CLI_REFRESH_TOKEN;
  setAccount(null);
});

test('resolveCreds: reads from environment (active account "default")', () => {
  process.env.GMAIL_CLI_CLIENT_ID = 'cid';
  process.env.GMAIL_CLI_CLIENT_SECRET = 'csec';
  process.env.GMAIL_CLI_REFRESH_TOKEN = 'rtok';
  assert.deepEqual(resolveCreds(), { account: 'default', clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' });
});

test('resolveCreds: throws when client is missing (names the account)', () => {
  assert.throws(() => resolveCreds(), /no OAuth client for account "default"/);
});

test('resolveCreds: throws when token missing but client present', () => {
  process.env.GMAIL_CLI_CLIENT_ID = 'cid';
  process.env.GMAIL_CLI_CLIENT_SECRET = 'csec';
  assert.throws(() => resolveCreds(), /not authenticated/);
});

test('resolveCreds: requireToken:false allows missing token', () => {
  process.env.GMAIL_CLI_CLIENT_ID = 'cid';
  process.env.GMAIL_CLI_CLIENT_SECRET = 'csec';
  assert.equal(resolveCreds({ requireToken: false }).refreshToken, undefined);
});

test('saveAccount then resolveCreds round-trips, and sets default', () => {
  saveAccount('personal', { client_id: 'pid', client_secret: 'psec', refresh_token: 'ptok' });
  assert.equal(loadConfig().default, 'personal');
  assert.deepEqual(resolveCreds(), { account: 'personal', clientId: 'pid', clientSecret: 'psec', refreshToken: 'ptok' });
});

test('multi-account: --account selects the credential set', () => {
  saveAccount('personal', { client_id: 'pid', client_secret: 'psec', refresh_token: 'ptok' });
  saveAccount('work', { client_id: 'wid', client_secret: 'wsec', refresh_token: 'wtok' });
  assert.deepEqual(listAccounts().sort(), ['personal', 'work']);
  setAccount('work');
  assert.equal(activeAccount(), 'work');
  assert.equal(resolveCreds().clientId, 'wid');
  setAccount('personal');
  assert.equal(resolveCreds().clientId, 'pid');
});

test('legacy flat config is read as the "default" account', () => {
  writeFileSync(process.env.GMAIL_CLI_CONFIG, JSON.stringify({ client_id: 'fid', client_secret: 'fsec', refresh_token: 'ftok' }));
  assert.deepEqual(listAccounts(), ['default']);
  assert.deepEqual(resolveCreds(), { account: 'default', clientId: 'fid', clientSecret: 'fsec', refreshToken: 'ftok' });
});

test('saveAccount migrates a legacy flat file into the accounts map', () => {
  writeFileSync(process.env.GMAIL_CLI_CONFIG, JSON.stringify({ client_id: 'fid', client_secret: 'fsec', refresh_token: 'ftok' }));
  saveAccount('work', { client_id: 'wid', client_secret: 'wsec', refresh_token: 'wtok' });
  const cfg = loadConfig();
  assert.equal(cfg.client_id, undefined); // legacy top-level keys removed
  assert.deepEqual(Object.keys(cfg.accounts).sort(), ['default', 'work']);
  assert.equal(cfg.accounts.default.client_id, 'fid');
});

test('env overrides the active account file creds per-field', () => {
  saveAccount('personal', { client_id: 'pid', client_secret: 'psec', refresh_token: 'ptok' });
  process.env.GMAIL_CLI_CLIENT_ID = 'envid';
  assert.equal(resolveCreds().clientId, 'envid');
  assert.equal(resolveCreds().clientSecret, 'psec');
});

test('configPath honors GMAIL_CLI_CONFIG', () => {
  assert.equal(configPath(), process.env.GMAIL_CLI_CONFIG);
});
