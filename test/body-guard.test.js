import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyBody } from '../lib/mime.js';

// --- refuses: every shape that would otherwise transmit an empty message -----

test('isEmptyBody: missing body (the blank-email bug) is empty', () => {
  // resolveBody() maps an omitted --body to '' via its fallback.
  assert.equal(isEmptyBody({ text: '' }), true);
});

test('isEmptyBody: undefined text is empty', () => {
  assert.equal(isEmptyBody({ text: undefined }), true);
});

test('isEmptyBody: no argument at all is empty', () => {
  assert.equal(isEmptyBody(), true);
});

test('isEmptyBody: whitespace-only is empty', () => {
  assert.equal(isEmptyBody({ text: '   ' }), true);
  assert.equal(isEmptyBody({ text: '\n\t  \n' }), true);
});

test('isEmptyBody: --html with no body and no text alternative is empty', () => {
  assert.equal(isEmptyBody({ html: '', text: undefined }), true);
});

// --- proceeds: the negatives. A guard that refuses everything would pass a
// --- positives-only suite, so these are the half that give the tests meaning.

test('isEmptyBody: ordinary text is NOT empty', () => {
  assert.equal(isEmptyBody({ text: 'hello' }), false);
});

test('isEmptyBody: html content is NOT empty even though text is undefined', () => {
  assert.equal(isEmptyBody({ html: '<p>hi</p>', text: undefined }), false);
});

test('isEmptyBody: "0" is real content, NOT empty', () => {
  // A truthiness check would wrongly reject this.
  assert.equal(isEmptyBody({ text: '0' }), false);
});

test('isEmptyBody: whitespace around real content is NOT empty', () => {
  assert.equal(isEmptyBody({ text: '  hi  ' }), false);
});

test('isEmptyBody: empty html WITH a text alternative is NOT empty', () => {
  // `--html --text "hi"` with no --body: resolveBody puts the plaintext
  // alternative in `text`. An html-precedence check would falsely reject this
  // real message. Empty means EVERY part is blank, not just the first one.
  assert.equal(isEmptyBody({ html: '', text: 'hi' }), false);
});

test('isEmptyBody: an attachment is content — attachment-only send is NOT empty', () => {
  // "here is the file" with no covering text is a legitimate send.
  assert.equal(isEmptyBody({ text: '' }, { attachments: 1 }), false);
  assert.equal(isEmptyBody({ html: '', text: '' }, { attachments: 2 }), false);
});

test('isEmptyBody: zero attachments does not rescue a blank body', () => {
  assert.equal(isEmptyBody({ text: '' }, { attachments: 0 }), true);
});
