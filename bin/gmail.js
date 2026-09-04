#!/usr/bin/env node
// gmail — a stateless, zero-dependency, agent-friendly Gmail CLI.
//
// No daemon: each command mints/reuses a cached OAuth access token and exits.
// Run `gmail auth` once to sign in, then `gmail help` for the command list.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gmail } from '../lib/api.js';
import { parseArgs } from '../lib/args.js';
import {
  buildRaw, header, extractBody, htmlToText,
  listAttachments, base64urlDecode, guessMimeType, resolveReplyRecipients, isEmptyBody,
} from '../lib/mime.js';
import { authorize } from '../lib/oauth.js';
import { resolveCreds, saveAccount, setAccount, activeAccount, listAccounts, configPath } from '../lib/config.js';

const asArray = (v) => (v === undefined ? [] : [].concat(v));
const out = (obj) => console.log(JSON.stringify(obj, null, 2));

// --- body / attachment helpers ----------------------------------------------
function readContent(inline, file) {
  if (file !== undefined) {
    if (file === '-' || file === true) return readFileSync(0, 'utf8');
    return readFileSync(file, 'utf8');
  }
  if (inline === '-' || inline === true) return readFileSync(0, 'utf8');
  return inline;
}

function resolveBody(flags, { fallback = '' } = {}) {
  const raw = readContent(flags.body, flags['body-file']);
  const content = raw === undefined ? fallback : raw;
  if (flags.html) {
    return { html: content, text: flags.text ? readContent(flags.text) : undefined };
  }
  return { text: content };
}

// --allow-empty must be the BARE flag. parseArgs turns `--allow-empty false`
// into the string 'false', which is truthy — so a plain truthiness check would
// let the very words "allow-empty false" disable the guard. Fail closed.
const allowEmpty = (flags) => flags['allow-empty'] === true;

// Shared message for the empty-body refusal on the verbs that transmit.
function emptyBodyError(usage) {
  return 'refusing to send an empty body — this is almost always a mistake '
    + '(a missing --body, or a syntax probe expecting usage text).\n'
    + `${usage}\n`
    + 'If you really mean to send an empty message, pass --allow-empty.';
}

function resolveAttachments(flags) {
  return asArray(flags.attach).map((p) => ({
    filename: basename(p), mimeType: guessMimeType(p), content: readFileSync(p),
  }));
}

let _me = null;
async function myAddress() {
  if (!_me) _me = (await gmail('GET', '/profile')).emailAddress;
  return _me;
}

// --- label resolution -------------------------------------------------------
let _labels = null;
async function allLabels() {
  if (!_labels) _labels = (await gmail('GET', '/labels')).labels || [];
  return _labels;
}
const SYSTEM_LABELS = ['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
async function resolveLabel(nameOrId) {
  if (SYSTEM_LABELS.includes(nameOrId.toUpperCase())) return nameOrId.toUpperCase();
  const hit = (await allLabels()).find((l) => l.id === nameOrId || l.name.toLowerCase() === nameOrId.toLowerCase());
  if (!hit) throw new Error(`unknown label: ${nameOrId} (run \`gmail labels\`)`);
  return hit.id;
}

async function resolveTargets(pos, flags) {
  const ids = [...pos];
  if (flags.query) {
    const { messages = [] } = await gmail('GET', '/messages', { query: { q: flags.query, maxResults: flags.max || 100 } });
    ids.push(...messages.map((m) => m.id));
  }
  return [...new Set(ids)];
}

async function applyLabels(ids, addLabelIds, removeLabelIds) {
  if (ids.length === 0) throw new Error('no target messages (pass ids or --query)');
  if (ids.length === 1) {
    const res = await gmail('POST', `/messages/${ids[0]}/modify`, { body: { addLabelIds, removeLabelIds } });
    return { id: res.id, labelIds: res.labelIds };
  }
  await gmail('POST', '/messages/batchModify', { body: { ids, addLabelIds, removeLabelIds } });
  return { modified: ids.length, ids };
}

// --- commands ---------------------------------------------------------------
const commands = {
  // auth [--account NAME] [--client-id X] [--client-secret Y] [--manual]
  async auth(pos, flags) {
    const account = flags.account || activeAccount();
    setAccount(account);
    const patch = {};
    if (flags['client-id']) patch.client_id = flags['client-id'];
    if (flags['client-secret']) patch.client_secret = flags['client-secret'];
    if (Object.keys(patch).length) saveAccount(account, patch);
    const { clientId, clientSecret } = resolveCreds({ requireToken: false });
    const refreshToken = await authorize({ clientId, clientSecret, manual: !!flags.manual });
    saveAccount(account, { refresh_token: refreshToken });
    const me = await gmail('GET', '/profile');
    out({ authenticated: true, account, email: me.emailAddress, config: configPath() });
  },

  // accounts — list configured accounts and the active/default one.
  accounts() {
    out({ active: activeAccount(), accounts: listAccounts() });
  },

  async profile() { out(await gmail('GET', '/profile')); },

  async labels() { out((await allLabels()).map(({ id, name, type }) => ({ id, name, type }))); },

  async list(pos, flags) {
    const q = pos.join(' ') || flags.query || undefined;
    const labelIds = flags.label ? [await resolveLabel(flags.label)] : undefined;
    const { messages = [] } = await gmail('GET', '/messages', { query: { q, maxResults: flags.max || 20, labelIds } });
    const rows = [];
    for (const m of messages) {
      const msg = await gmail('GET', `/messages/${m.id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } });
      rows.push({
        id: msg.id, threadId: msg.threadId, date: header(msg.payload, 'Date'),
        from: header(msg.payload, 'From'), subject: header(msg.payload, 'Subject'),
        unread: (msg.labelIds || []).includes('UNREAD'), snippet: msg.snippet,
      });
    }
    if (flags.json) return out(rows);
    if (!rows.length) return console.log('(no messages)');
    for (const r of rows) {
      console.log(`${r.unread ? '●' : ' '} ${r.id}  ${r.date}`);
      console.log(`   From:    ${r.from}`);
      console.log(`   Subject: ${r.subject}`);
      console.log(`   ${r.snippet}\n`);
    }
  },

  async search(pos, flags) { return commands.list(pos, flags); },

  async threads(pos, flags) {
    const q = pos.join(' ') || flags.query || undefined;
    const { threads = [] } = await gmail('GET', '/threads', { query: { q, maxResults: flags.max || 20 } });
    const rows = [];
    for (const t of threads) {
      const th = await gmail('GET', `/threads/${t.id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } });
      const last = th.messages[th.messages.length - 1];
      rows.push({ threadId: th.id, messages: th.messages.length, subject: header(last.payload, 'Subject'), from: header(last.payload, 'From'), date: header(last.payload, 'Date'), snippet: th.messages[0].snippet });
    }
    if (flags.json) return out(rows);
    if (!rows.length) return console.log('(no threads)');
    for (const r of rows) {
      console.log(`${r.threadId}  (${r.messages} msg)  ${r.date}`);
      console.log(`   ${r.from}`);
      console.log(`   ${r.subject}\n`);
    }
  },

  async read(pos, flags) {
    const id = pos[0];
    if (!id) throw new Error('usage: gmail read <messageId>');
    if (flags.raw) {
      const msg = await gmail('GET', `/messages/${id}`, { query: { format: 'raw' } });
      return process.stdout.write(base64urlDecode(msg.raw));
    }
    const msg = await gmail('GET', `/messages/${id}`, { query: { format: 'full' } });
    if (flags.json) return out(msg);
    const body = extractBody(msg.payload);
    const atts = listAttachments(msg.payload);
    console.log(`Date:    ${header(msg.payload, 'Date')}`);
    console.log(`From:    ${header(msg.payload, 'From')}`);
    console.log(`To:      ${header(msg.payload, 'To')}`);
    const cc = header(msg.payload, 'Cc');
    if (cc) console.log(`Cc:      ${cc}`);
    console.log(`Subject: ${header(msg.payload, 'Subject')}`);
    console.log(`Labels:  ${(msg.labelIds || []).join(', ')}`);
    if (atts.length) console.log(`Attach:  ${atts.map((a) => `${a.filename} (${a.mimeType}, ${a.size}B)`).join('; ')}`);
    console.log('');
    if (flags.html && body.html) console.log(body.html);
    else console.log(body.text || (body.html ? htmlToText(body.html) : msg.snippet));
  },

  async thread(pos, flags) {
    const id = pos[0];
    if (!id) throw new Error('usage: gmail thread <threadId>');
    const th = await gmail('GET', `/threads/${id}`, { query: { format: 'full' } });
    if (flags.json) return out(th);
    for (const msg of th.messages || []) {
      const body = extractBody(msg.payload);
      console.log('─'.repeat(60));
      console.log(`Date:    ${header(msg.payload, 'Date')}`);
      console.log(`From:    ${header(msg.payload, 'From')}`);
      console.log(`Subject: ${header(msg.payload, 'Subject')}\n`);
      console.log(body.text || (body.html ? htmlToText(body.html) : msg.snippet));
      console.log('');
    }
  },

  async attachments(pos) {
    const id = pos[0];
    if (!id) throw new Error('usage: gmail attachments <messageId>');
    const msg = await gmail('GET', `/messages/${id}`, { query: { format: 'full' } });
    out(listAttachments(msg.payload));
  },

  async download(pos, flags) {
    const id = pos[0];
    if (!id) throw new Error('usage: gmail download <messageId> [--attachment <id>] [--out <dir>]');
    const msg = await gmail('GET', `/messages/${id}`, { query: { format: 'full' } });
    let atts = listAttachments(msg.payload);
    if (flags.attachment) atts = atts.filter((a) => a.attachmentId === flags.attachment);
    if (!atts.length) throw new Error('no matching attachments');
    const dir = (flags.out && flags.out !== true) ? flags.out : '.';
    const saved = [];
    for (const a of atts) {
      const data = await gmail('GET', `/messages/${id}/attachments/${a.attachmentId}`);
      const path = `${dir.replace(/\/$/, '')}/${a.filename}`;
      writeFileSync(path, base64urlDecode(data.data));
      saved.push({ file: path, bytes: a.size });
    }
    out({ downloaded: saved });
  },

  async send(pos, flags) {
    const usage = 'usage: gmail send --to <addr> --subject <s> --body <text>|--body-file <f> [--html] [--attach <f>]... [--cc] [--bcc] [--allow-empty]';
    if (!flags.to) throw new Error(usage);
    // Resolve body and attachments exactly ONCE and reuse — see the note in
    // `reply`; with `--body -` a second resolve would read an exhausted stdin.
    const { text, html } = resolveBody(flags);
    const attachments = resolveAttachments(flags);
    if (!allowEmpty(flags) && isEmptyBody({ text, html }, { attachments: attachments.length })) throw new Error(emptyBodyError(usage));
    const raw = buildRaw({ to: asArray(flags.to), cc: asArray(flags.cc), bcc: asArray(flags.bcc), subject: flags.subject || '', text, html, attachments });
    const res = await gmail('POST', '/messages/send', { body: { raw } });
    out({ sent: true, id: res.id, threadId: res.threadId });
  },

  async reply(pos, flags) {
    const usage = 'usage: gmail reply <messageId> --body <text> [--html] [--all] [--to <addr>] [--cc <addr>] [--bcc <addr>] [--attach <f>]... [--allow-empty]';
    const id = pos[0];
    if (!id) throw new Error(usage);
    // ⚠ Resolve the body exactly ONCE, here, and reuse it for the send below.
    // `--body -` / `--body-file -` read stdin via readFileSync(0); a second
    // resolve returns '' because the stream is already exhausted. Validating
    // with one call and sending with another would therefore transmit the empty
    // string the guard had just approved — the guard would CAUSE the blank
    // email it exists to prevent.
    const body = resolveBody(flags);
    const attachments = resolveAttachments(flags);
    // Checked BEFORE the GET below: a malformed invocation should cost nothing
    // and must never reach the send call.
    if (!allowEmpty(flags) && isEmptyBody(body, { attachments: attachments.length })) throw new Error(emptyBodyError(usage));
    const orig = await gmail('GET', `/messages/${id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'Reply-To'] } });
    const p = orig.payload;
    const me = await myAddress();
    // --to overrides the default "reply to sender" recipient — needed when the
    // ORIGINAL message's sender was us (a thread of our own outbound mail), where
    // the default would loop the reply back to our own address. Still a real
    // `reply` (same threadId + In-Reply-To/References below), not a `send`.
    const { to, cc, bcc } = resolveReplyRecipients({
      fromHeader: header(p, 'From'),
      replyToHeader: header(p, 'Reply-To'),
      toHeader: header(p, 'To'),
      ccHeader: header(p, 'Cc'),
      me,
      all: !!flags.all,
      to: flags.to ? asArray(flags.to) : [],
      cc: flags.cc ? asArray(flags.cc) : [],
      bcc: flags.bcc ? asArray(flags.bcc) : []
    });
    const subject = header(p, 'Subject');
    const msgId = header(p, 'Message-ID');
    const refs = [header(p, 'References'), msgId].filter(Boolean).join(' ');
    const { text, html } = body;
    const raw = buildRaw({ to, cc, bcc, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text, html, attachments, inReplyTo: msgId || undefined, references: refs || undefined });
    const res = await gmail('POST', '/messages/send', { body: { raw, threadId: orig.threadId } });
    out({ replied: true, id: res.id, threadId: res.threadId, to, cc, bcc });
  },

  async forward(pos, flags) {
    const id = pos[0];
    if (!id || !flags.to) throw new Error('usage: gmail forward <messageId> --to <addr> [--body <intro>] [--html] [--no-attachments]');
    const orig = await gmail('GET', `/messages/${id}`, { query: { format: 'full' } });
    const p = orig.payload;
    const body = extractBody(p);
    const intro = resolveBody(flags, { fallback: '' });
    const quotedHeader = ['---------- Forwarded message ----------', `From: ${header(p, 'From')}`, `Date: ${header(p, 'Date')}`, `Subject: ${header(p, 'Subject')}`, `To: ${header(p, 'To')}`, ''].join('\n');
    let attachments = [];
    if (!flags['no-attachments']) {
      for (const a of listAttachments(p)) {
        const data = await gmail('GET', `/messages/${id}/attachments/${a.attachmentId}`);
        attachments.push({ filename: a.filename, mimeType: a.mimeType, content: base64urlDecode(data.data) });
      }
    }
    let sendBody;
    if (flags.html) {
      const origHtml = body.html || `<pre>${htmlToText(body.text || '')}</pre>`;
      sendBody = { html: `${intro.html || ''}<br><br>${quotedHeader.replace(/\n/g, '<br>')}<br>${origHtml}` };
    } else {
      sendBody = { text: `${intro.text || ''}\n\n${quotedHeader}\n${body.text || htmlToText(body.html || '')}` };
    }
    const subject = header(p, 'Subject');
    const raw = buildRaw({ to: asArray(flags.to), cc: asArray(flags.cc), bcc: asArray(flags.bcc), subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`, ...sendBody, attachments });
    const res = await gmail('POST', '/messages/send', { body: { raw } });
    out({ forwarded: true, id: res.id, threadId: res.threadId, attachments: attachments.length });
  },

  async draft(pos, flags) {
    if (!flags.to) throw new Error('usage: gmail draft --to <addr> --subject <s> --body <text> [--html] [--attach <f>]...');
    const { text, html } = resolveBody(flags);
    const raw = buildRaw({ to: asArray(flags.to), cc: asArray(flags.cc), bcc: asArray(flags.bcc), subject: flags.subject || '', text, html, attachments: resolveAttachments(flags) });
    const res = await gmail('POST', '/drafts', { body: { message: { raw } } });
    out({ draft: true, id: res.id, messageId: res.message?.id });
  },

  async drafts(pos, flags) {
    const { drafts = [] } = await gmail('GET', '/drafts', { query: { maxResults: flags.max || 20 } });
    const rows = [];
    for (const d of drafts) {
      const msg = await gmail('GET', `/messages/${d.message.id}`, { query: { format: 'metadata', metadataHeaders: ['To', 'Subject'] } });
      rows.push({ draftId: d.id, to: header(msg.payload, 'To'), subject: header(msg.payload, 'Subject'), snippet: msg.snippet });
    }
    out(rows);
  },

  async 'draft-send'(pos) {
    const id = pos[0];
    if (!id) throw new Error('usage: gmail draft-send <draftId>');
    const res = await gmail('POST', '/drafts/send', { body: { id } });
    out({ sent: true, id: res.id, threadId: res.threadId });
  },

  async 'draft-delete'(pos) {
    const id = pos[0];
    if (!id) throw new Error('usage: gmail draft-delete <draftId>');
    await gmail('DELETE', `/drafts/${id}`);
    out({ deleted: true, draftId: id });
  },

  async modify(pos, flags) {
    const ids = await resolveTargets(pos, flags);
    const addLabelIds = [];
    const removeLabelIds = [];
    for (const l of asArray(flags.add)) addLabelIds.push(await resolveLabel(l));
    for (const l of asArray(flags.remove)) removeLabelIds.push(await resolveLabel(l));
    out(await applyLabels(ids, addLabelIds, removeLabelIds));
  },

  async trash(pos, flags) {
    const ids = await resolveTargets(pos, flags);
    const done = [];
    for (const id of ids) { await gmail('POST', `/messages/${id}/trash`); done.push(id); }
    out({ trashed: done.length, ids: done });
  },

  async untrash(pos, flags) {
    const ids = await resolveTargets(pos, flags);
    const done = [];
    for (const id of ids) { await gmail('POST', `/messages/${id}/untrash`); done.push(id); }
    out({ untrashed: done.length, ids: done });
  },

  async markread(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), [], ['UNREAD'])); },
  async markunread(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), ['UNREAD'], [])); },
  async star(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), ['STARRED'], [])); },
  async unstar(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), [], ['STARRED'])); },
  async archive(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), [], ['INBOX'])); },
  async unarchive(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), ['INBOX'], [])); },
  async spam(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), ['SPAM'], ['INBOX'])); },
  async unspam(pos, flags) { out(await applyLabels(await resolveTargets(pos, flags), ['INBOX'], ['SPAM'])); },

  async 'label-create'(pos, flags) {
    const name = pos[0] || flags.name;
    if (!name) throw new Error('usage: gmail label-create <name>');
    const res = await gmail('POST', '/labels', { body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
    out({ created: true, id: res.id, name: res.name });
  },

  async 'label-delete'(pos) {
    if (!pos[0]) throw new Error('usage: gmail label-delete <name-or-id>');
    const id = await resolveLabel(pos[0]);
    await gmail('DELETE', `/labels/${id}`);
    out({ deleted: true, id });
  },

  async 'label-rename'(pos, flags) {
    if (!pos[0] || !flags.to) throw new Error('usage: gmail label-rename <name-or-id> --to <newName>');
    const id = await resolveLabel(pos[0]);
    const res = await gmail('PATCH', `/labels/${id}`, { body: { name: flags.to } });
    out({ renamed: true, id: res.id, name: res.name });
  },

  help() {
    console.log(`gmail — stateless, zero-dep Gmail CLI

Setup:
  gmail auth [--account NAME] [--manual] [--client-id X --client-secret Y]
                                         one-time OAuth sign-in
  gmail accounts                         list configured accounts

Any command takes --account NAME to target a specific inbox (default: the
configured "default" account).

Read:
  profile | labels
  list [query] [--max N] [--label L] [--json]
  search <query>                         alias for list
  threads [query] [--max N] [--json]
  read <id> [--html] [--json] [--raw]    (--raw = .eml to stdout)
  thread <id> [--json]
  attachments <id>
  download <id> [--attachment ID] [--out DIR]

Write (body: --body TEXT | --body-file F | pipe '-'; --html sends HTML+text):
  send --to A --subject S --body B [--html] [--attach F]... [--cc] [--bcc]
  reply <id> --body B [--html] [--all] [--to A] [--cc A] [--bcc A] [--attach F]...
  forward <id> --to A [--body intro] [--html] [--no-attachments]
  draft --to A --subject S --body B [--html] [--attach F]...
  drafts | draft-send <draftId> | draft-delete <draftId>

Organize (accept <id>... and/or --query Q for batch):
  modify <id...> [--add L]... [--remove L]...
  trash | untrash | markread | markunread | star | unstar
  archive | unarchive | spam | unspam
  label-create <name> | label-delete <name> | label-rename <name> --to <new>

Docs: https://github.com/harteWired/gmail-cli`);
  },
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  // Object.hasOwn, not a bare lookup: `commands['constructor']` and
  // `commands['toString']` resolve to inherited Object prototype members, which
  // are truthy — so `gmail constructor` skipped the unknown-command error and
  // silently exited 0 instead of reporting a typo.
  const command = Object.hasOwn(commands, cmd ?? '') ? commands[cmd] : undefined;
  // `--help`/`-h` are accepted aliases, so they must not also be reported as an
  // unknown command or exit non-zero — a help request that exits 1 breaks any
  // caller running under `set -e`.
  const isHelp = cmd === 'help' || cmd === '--help' || cmd === '-h';
  const unknown = Boolean(cmd) && !command && !isHelp;
  if (!cmd || isHelp || !command) {
    if (unknown) console.error(`unknown command: ${cmd}\n`);
    commands.help();
    process.exit(unknown ? 1 : 0);
  }
  const { positional, flags } = parseArgs(rest);
  if (flags.account) setAccount(flags.account); // global: select which account this command uses
  try {
    await command(positional, flags);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

main();
