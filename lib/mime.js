// MIME helpers: build outgoing RFC 2822 messages (with multipart/alternative
// and attachments) and decode incoming ones.

import { randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Encode a header value that may contain non-ASCII (RFC 2047, B-encoding).
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// Wrap a base64 string at 76 chars per RFC 2045.
const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

// A minimal extension -> MIME type map for attachments.
const MIME_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.zip': 'application/zip', '.doc': 'application/msword', '.ics': 'text/calendar',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export function guessMimeType(filename) {
  return MIME_TYPES[extname(filename).toLowerCase()] || 'application/octet-stream';
}

// Build a single MIME part from a set of header lines and a base64 body.
function part(headers, bodyBase64) {
  return [...headers, '', wrap76(bodyBase64)].join('\r\n');
}

// Build the body section (everything below the top-level headers): handles
// text-only, html+text (multipart/alternative), and attachments
// (multipart/mixed wrapping the body). Returns { headers[], body }.
function buildBody({ text, html, attachments }) {
  // 1. The message body: text/plain, or multipart/alternative when HTML exists.
  let bodyHeaders;
  let bodyContent;
  if (html) {
    const altBoundary = `alt_${randomBytes(12).toString('hex')}`;
    const textPart = part(
      ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'],
      Buffer.from(text || htmlToText(html), 'utf8').toString('base64')
    );
    const htmlPart = part(
      ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'],
      Buffer.from(html, 'utf8').toString('base64')
    );
    bodyHeaders = [`Content-Type: multipart/alternative; boundary="${altBoundary}"`];
    bodyContent = [
      `--${altBoundary}`, textPart,
      `--${altBoundary}`, htmlPart,
      `--${altBoundary}--`,
    ].join('\r\n');
  } else {
    bodyHeaders = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
    bodyContent = wrap76(Buffer.from(text || '', 'utf8').toString('base64'));
  }

  // 2. No attachments -> the body is the whole message.
  if (!attachments || attachments.length === 0) {
    return { headers: bodyHeaders, body: bodyContent };
  }

  // 3. Attachments -> multipart/mixed [ bodyPart, ...attachments ].
  const mixedBoundary = `mix_${randomBytes(12).toString('hex')}`;
  const bodyPart = [...bodyHeaders, '', bodyContent].join('\r\n');
  const attachParts = attachments.map((a) => {
    const name = encodeHeader(a.filename);
    return part(
      [
        `Content-Type: ${a.mimeType || guessMimeType(a.filename)}; name="${name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${name}"`,
      ],
      a.content.toString('base64')
    );
  });
  const body = [
    `--${mixedBoundary}`, bodyPart,
    ...attachParts.flatMap((p) => [`--${mixedBoundary}`, p]),
    `--${mixedBoundary}--`,
  ].join('\r\n');
  return { headers: [`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`], body };
}

// Build a base64url-encoded raw message for messages.send / drafts.
// opts: { from, to[], cc[], bcc[], subject, text, html, attachments[],
//         inReplyTo, references }
// attachments: [{ filename, mimeType?, content: Buffer }]
export function buildRaw(opts) {
  const addr = (arr) => (Array.isArray(arr) ? arr.join(', ') : arr);
  const top = [];
  if (opts.from) top.push(`From: ${opts.from}`);
  top.push(`To: ${addr(opts.to)}`);
  if (opts.cc?.length) top.push(`Cc: ${addr(opts.cc)}`);
  if (opts.bcc?.length) top.push(`Bcc: ${addr(opts.bcc)}`);
  top.push(`Subject: ${encodeHeader(opts.subject || '')}`);
  if (opts.inReplyTo) top.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) top.push(`References: ${opts.references}`);
  top.push('MIME-Version: 1.0');

  const { headers, body } = buildBody(opts);
  return base64url([...top, ...headers, '', body].join('\r\n'));
}

// Pull a header value (case-insensitive) from a message payload.
export function header(payload, name) {
  const h = payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// Recursively extract the best text body. Returns { text, html }.
export function extractBody(payload) {
  const out = { text: '', html: '' };
  const walk = (p) => {
    if (!p) return;
    const mime = p.mimeType || '';
    if (p.body?.data) {
      const decoded = base64urlDecode(p.body.data).toString('utf8');
      if (mime === 'text/plain' && !out.text) out.text = decoded;
      else if (mime === 'text/html' && !out.html) out.html = decoded;
    }
    if (p.parts) p.parts.forEach(walk);
  };
  walk(payload);
  return out;
}

// List attachment parts in a payload: [{ filename, mimeType, size, attachmentId }].
export function listAttachments(payload) {
  const found = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      found.push({
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.body.size,
        attachmentId: p.body.attachmentId,
      });
    }
    if (p.parts) p.parts.forEach(walk);
  };
  walk(payload);
  return found;
}

// Very light HTML -> text fallback for display and for the plaintext alternative.
export function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Parse "Name <a@b.com>, c@d.com" -> [{ name, email, raw }].
export function parseAddrs(str) {
  if (!str) return [];
  return str.split(',').map((chunk) => {
    const m = chunk.match(/<([^>]+)>/);
    const email = (m ? m[1] : chunk).trim();
    const name = m ? chunk.slice(0, m.index).trim().replace(/^"|"$/g, '') : '';
    return { name, email, raw: chunk.trim() };
  }).filter((a) => a.email);
}

export { basename };
