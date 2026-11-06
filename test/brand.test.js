import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const publicFile = name => readFile(new URL(`../public/${name}`, import.meta.url));

test('share preview is declared in initial HTML for crawlers without JavaScript', async () => {
  const html = (await publicFile('index.html')).toString();
  for (const property of ['og:title', 'og:description', 'og:image', 'og:image:alt', 'og:image:width', 'og:image:height']) {
    assert.match(html, new RegExp(`<meta property="${property}" content="[^"]+">`));
  }
  assert.match(html, /property="og:image" content="https:\/\/quedem-one\.vercel\.app\/social-preview\.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180"/);
  assert(!html.includes('og:url'), 'A shared event must retain its own invitation URL');
});

test('preview and home-screen icon have their exact required PNG sizes', async () => {
  for (const [file, width, height] of [['social-preview.png', 1200, 630], ['apple-touch-icon.png', 180, 180]]) {
    const data = await publicFile(file);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), width);
    assert.equal(data.readUInt32BE(20), height);
  }
  const icon = await publicFile('favicon.ico');
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 2);
  for (const [index, size] of [[0, 32], [1, 48]]) {
    const entry = 6 + index * 16;
    assert.equal(icon[entry], size);
    assert.equal(icon[entry + 1], size);
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    assert(offset + length <= icon.length);
    assert.equal(icon.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
  }
});

test('calendar selector is a native expandable menu rather than a show/hide button', async () => {
  const html = (await publicFile('index.html')).toString();
  assert.match(html, /<details id="calendar-menu"[^>]*><summary>/);
  assert(!html.includes('toggle-calendars'));
  assert.match(html, /id="google"[^>]*>Connectar Google Calendar</);
});
