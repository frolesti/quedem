import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { AppError } from './schedule.js';

export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const eventCode = () => randomBytes(7).toString('hex').toUpperCase();

function key() {
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
    throw new AppError('Falta configurar la clau privada del servidor.', 503);
  }
  return createHash('sha256').update(process.env.APP_SECRET).digest();
}

export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decrypt(value) {
  const buffer = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key(), buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString());
}

export function cookie(req, name) {
  const entry = (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return entry?.slice(name.length + 1);
}

export const validToken = token => typeof token === 'string' && /^[\w-]{43}$/.test(token);

export function setCookie(res, name, token, maxAge = 7776000) {
  const secure = process.env.APP_URL?.startsWith('https:') ? '; Secure' : '';
  const value = `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(previous ? [previous].flat() : []), value]);
}

export function session(req, res, code) {
  const name = `quedem_${code}`;
  let token = cookie(req, name);
  if (!validToken(token)) {
    token = randomToken();
    setCookie(res, name, token);
  }
  return hash(token);
}

export function requireOrigin(req) {
  const expected = new URL(process.env.APP_URL || 'http://localhost:3000').origin;
  if (req.headers.origin !== expected) throw new AppError('Origen de la petició no autoritzat.', 403);
}
