import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCreds, saveConfig, loadConfig, configPath } from '../lib/config.js';

// Isolate every test from the real ~/.config by pointing at a temp config file
// and clearing credential env vars.
beforeEach(() => {
  process.env.GMAIL_CLI_CONFIG = join(tmpdir(), `gmail-cli-test-${process.pid}-${Math.floor(process.hrtime()[1])}.json`);
  delete process.env.GMAIL_CLI_CLIENT_ID;
  delete process.env.GMAIL_CLI_CLIENT_SECRET;
  delete process.env.GMAIL_CLI_REFRESH_TOKEN;
});

test('resolveCreds: reads from environment', () => {
  process.env.GMAIL_CLI_CLIENT_ID = 'cid';
  process.env.GMAIL_CLI_CLIENT_SECRET = 'csec';
  process.env.GMAIL_CLI_REFRESH_TOKEN = 'rtok';
  assert.deepEqual(resolveCreds(), { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' });
});

test('resolveCreds: throws when client is missing', () => {
  assert.throws(() => resolveCreds(), /no OAuth client configured/);
});

test('resolveCreds: throws when token missing but client present', () => {
  process.env.GMAIL_CLI_CLIENT_ID = 'cid';
  process.env.GMAIL_CLI_CLIENT_SECRET = 'csec';
  assert.throws(() => resolveCreds(), /not authenticated/);
});

test('resolveCreds: requireToken:false allows missing token', () => {
  process.env.GMAIL_CLI_CLIENT_ID = 'cid';
  process.env.GMAIL_CLI_CLIENT_SECRET = 'csec';
  const creds = resolveCreds({ requireToken: false });
  assert.equal(creds.clientId, 'cid');
  assert.equal(creds.refreshToken, undefined);
});

test('saveConfig then resolveCreds round-trips via file', () => {
  saveConfig({ client_id: 'fid', client_secret: 'fsec', refresh_token: 'ftok' });
  assert.deepEqual(loadConfig(), { client_id: 'fid', client_secret: 'fsec', refresh_token: 'ftok' });
  assert.deepEqual(resolveCreds(), { clientId: 'fid', clientSecret: 'fsec', refreshToken: 'ftok' });
});

test('env overrides file', () => {
  saveConfig({ client_id: 'fid', client_secret: 'fsec', refresh_token: 'ftok' });
  process.env.GMAIL_CLI_CLIENT_ID = 'envid';
  assert.equal(resolveCreds().clientId, 'envid');
  assert.equal(resolveCreds().clientSecret, 'fsec');
});

test('configPath honors GMAIL_CLI_CONFIG', () => {
  assert.equal(configPath(), process.env.GMAIL_CLI_CONFIG);
});
