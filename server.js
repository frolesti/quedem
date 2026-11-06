import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import handler from './api/index.js';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/social-preview.png': ['social-preview.png', 'image/png'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png']
};
http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) return handler(req, res);
  const file = files[path];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(fileURLToPath(new URL(`./public/${file[0]}`, import.meta.url)));
    res.setHeader('Content-Type', file[1]);
    res.end(content);
  } catch (error) {
    console.error('Static file error:', error.message);
    res.writeHead(500); res.end('Error carregant la pàgina.');
  }
}).listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Quedem: http://localhost:${process.env.PORT || 3000}`));
