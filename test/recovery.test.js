import test from 'node:test';
import assert from 'node:assert/strict';
import { validToken, randomToken, hash, session, setCookie } from '../lib/security.js';

test('recovery secrets require full random-token format', () => {
  const token = randomToken();
  assert(validToken(token));
  assert.equal(hash(token).length, 64);
  for (const invalid of [undefined, null, 43, {}, '', 'short', 'a'.repeat(44), '/'.repeat(43)]) {
    assert.equal(validToken(invalid), false);
  }
});

test('new visitor and recovered access cookies coexist and are HttpOnly', () => {
  const headers = new Map();
  const res = {
    getHeader: name => headers.get(name),
    setHeader: (name, value) => headers.set(name, value)
  };
  const token = randomToken();
  const browser = session({ headers: {} }, res, 'ABCDEF12345678');
  setCookie(res, 'quedem_edit_ABCDEF12345678', token);
  const cookies = headers.get('Set-Cookie');
  assert.equal(cookies.length, 2);
  assert.notEqual(browser, hash(token));
  for (const cookie of cookies) {
    assert.match(cookie, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=7776000/);
  }
  setCookie(res, 'quedem_edit_ABCDEF12345678', '', 0);
  assert.match(headers.get('Set-Cookie')[2], /Max-Age=0/);
});
