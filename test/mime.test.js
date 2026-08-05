import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRaw, header, extractBody, htmlToText,
  listAttachments, guessMimeType, parseAddrs, base64urlDecode, resolveReplyRecipients,
} from '../lib/mime.js';

const decode = (raw) => base64urlDecode(raw).toString('utf8');

test('buildRaw: plain text is a single text/plain part', () => {
  const msg = decode(buildRaw({ to: ['a@b.com'], subject: 'Hi', text: 'hello' }));
  assert.match(msg, /^To: a@b\.com/m);
  assert.match(msg, /^Subject: Hi/m);
  assert.match(msg, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(msg, /multipart/);
  // body is base64 of "hello" (use includes — base64 can contain regex metachars)
  assert.ok(msg.includes(Buffer.from('hello').toString('base64')));
});

test('buildRaw: html produces multipart/alternative with text + html', () => {
  const msg = decode(buildRaw({ to: ['a@b.com'], subject: 'S', html: '<p>hi</p>' }));
  assert.match(msg, /Content-Type: multipart\/alternative; boundary="alt_/);
  assert.match(msg, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(msg, /Content-Type: text\/html; charset=UTF-8/);
  // html present, and an auto-generated plaintext alternative present
  assert.ok(msg.includes(Buffer.from('<p>hi</p>').toString('base64')));
  assert.ok(msg.includes(Buffer.from('hi').toString('base64')));
});

test('buildRaw: attachments produce multipart/mixed wrapping the body', () => {
  const msg = decode(buildRaw({
    to: ['a@b.com'], subject: 'S', text: 'body',
    attachments: [{ filename: 'r.txt', mimeType: 'text/plain', content: Buffer.from('DATA') }],
  }));
  assert.match(msg, /Content-Type: multipart\/mixed; boundary="mix_/);
  assert.match(msg, /Content-Disposition: attachment; filename="r\.txt"/);
  assert.ok(msg.includes(Buffer.from('DATA').toString('base64')));
});

test('buildRaw: cc, bcc, and threading headers', () => {
  const msg = decode(buildRaw({
    to: ['a@b.com'], cc: ['c@d.com'], bcc: ['e@f.com'], subject: 'S', text: 'x',
    inReplyTo: '<abc@mail>', references: '<abc@mail>',
  }));
  assert.match(msg, /^Cc: c@d\.com/m);
  assert.match(msg, /^Bcc: e@f\.com/m);
  assert.match(msg, /^In-Reply-To: <abc@mail>/m);
  assert.match(msg, /^References: <abc@mail>/m);
});

test('buildRaw: non-ASCII subject is RFC 2047 encoded', () => {
  const msg = decode(buildRaw({ to: ['a@b.com'], subject: 'Café ☕', text: 'x' }));
  assert.match(msg, /^Subject: =\?UTF-8\?B\?/m);
});

test('header: case-insensitive lookup', () => {
  const payload = { headers: [{ name: 'From', value: 'x@y.com' }, { name: 'Subject', value: 'Hi' }] };
  assert.equal(header(payload, 'from'), 'x@y.com');
  assert.equal(header(payload, 'SUBJECT'), 'Hi');
  assert.equal(header(payload, 'Missing'), '');
});

test('extractBody: prefers text/plain, falls back to html', () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('plain body') } },
      { mimeType: 'text/html', body: { data: b64('<b>html body</b>') } },
    ],
  };
  const { text, html } = extractBody(payload);
  assert.equal(text, 'plain body');
  assert.equal(html, '<b>html body</b>');
});

test('listAttachments: finds parts with filename + attachmentId', () => {
  const payload = {
    parts: [
      { mimeType: 'text/plain', body: { data: 'x' } },
      { filename: 'a.pdf', mimeType: 'application/pdf', body: { attachmentId: 'ATT1', size: 99 } },
    ],
  };
  const atts = listAttachments(payload);
  assert.equal(atts.length, 1);
  assert.deepEqual(atts[0], { filename: 'a.pdf', mimeType: 'application/pdf', size: 99, attachmentId: 'ATT1' });
});

test('htmlToText: strips tags and decodes entities', () => {
  const out = htmlToText('<p>Hello &amp; <strong>world</strong></p><br><script>x()</script>');
  assert.match(out, /Hello & world/);
  assert.doesNotMatch(out, /<|script/);
});

test('guessMimeType: by extension, octet-stream fallback', () => {
  assert.equal(guessMimeType('a.pdf'), 'application/pdf');
  assert.equal(guessMimeType('IMG.PNG'), 'image/png');
  assert.equal(guessMimeType('unknown.xyz'), 'application/octet-stream');
});

test('parseAddrs: names, angle brackets, bare emails', () => {
  const addrs = parseAddrs('Matt Harte <m@h.com>, plain@x.com, "Quoted Name" <q@z.com>');
  assert.equal(addrs.length, 3);
  assert.deepEqual(addrs[0], { name: 'Matt Harte', email: 'm@h.com', raw: 'Matt Harte <m@h.com>' });
  assert.equal(addrs[1].email, 'plain@x.com');
  assert.equal(addrs[2].name, 'Quoted Name');
  assert.equal(addrs[2].email, 'q@z.com');
});

test('parseAddrs: empty input', () => {
  assert.deepEqual(parseAddrs(''), []);
  assert.deepEqual(parseAddrs(undefined), []);
});

test('resolveReplyRecipients: default replies to From', () => {
  const r = resolveReplyRecipients({ fromHeader: 'Alice <a@x.com>', toHeader: 'me@x.com', me: 'me@x.com' });
  assert.deepEqual(r, { to: ['Alice <a@x.com>'], cc: [], bcc: [] });
});

test('resolveReplyRecipients: Reply-To wins over From', () => {
  const r = resolveReplyRecipients({ fromHeader: 'Alice <a@x.com>', replyToHeader: 'Bob <b@x.com>', toHeader: 'me@x.com', me: 'me@x.com' });
  assert.deepEqual(r.to, ['Bob <b@x.com>']);
});

test('resolveReplyRecipients: WM#1564 — a self-sent message would otherwise loop the reply back to us', () => {
  // We sent the original: From is our own address, correspondent is in To.
  const r = resolveReplyRecipients({ fromHeader: 'Me <me@x.com>', toHeader: 'Correspondent <c@x.com>', me: 'me@x.com' });
  assert.deepEqual(r.to, ['Me <me@x.com>'], 'unpatched default behavior: loops back to us');

  // --to fixes it while staying a reply (caller still uses the same threadId
  // + In-Reply-To/References — this function only resolves recipients).
  const fixed = resolveReplyRecipients({ fromHeader: 'Me <me@x.com>', toHeader: 'Correspondent <c@x.com>', me: 'me@x.com', to: ['Correspondent <c@x.com>'] });
  assert.deepEqual(fixed.to, ['Correspondent <c@x.com>']);
  assert.deepEqual(fixed.cc, []);
});

test('resolveReplyRecipients: --all folds in the rest of the original To/Cc as Cc, excluding self and duplicates', () => {
  const r = resolveReplyRecipients({
    fromHeader: 'Alice <a@x.com>',
    toHeader: 'me@x.com, Carol <c@x.com>',
    ccHeader: 'Dave <d@x.com>, Alice <a@x.com>',
    me: 'me@x.com',
    all: true
  });
  assert.deepEqual(r.to, ['Alice <a@x.com>']);
  assert.deepEqual(r.cc, ['Carol <c@x.com>', 'Dave <d@x.com>']); // me + Alice (already the To) excluded
});

test('resolveReplyRecipients: --all with an explicit --to excludes that address (and its own cc) from the auto-cc pass', () => {
  const r = resolveReplyRecipients({
    fromHeader: 'Me <me@x.com>',
    toHeader: 'Correspondent <c@x.com>',
    ccHeader: 'Eve <e@x.com>',
    me: 'me@x.com',
    all: true,
    to: ['Correspondent <c@x.com>'],
    cc: ['Frank <f@x.com>']
  });
  assert.deepEqual(r.to, ['Correspondent <c@x.com>']);
  assert.deepEqual(r.cc, ['Frank <f@x.com>', 'Eve <e@x.com>']); // Correspondent not re-added; Eve pulled in
});

test('resolveReplyRecipients: explicit --bcc passes through untouched', () => {
  const r = resolveReplyRecipients({ fromHeader: 'Alice <a@x.com>', toHeader: 'me@x.com', me: 'me@x.com', bcc: ['audit@x.com'] });
  assert.deepEqual(r.bcc, ['audit@x.com']);
});
