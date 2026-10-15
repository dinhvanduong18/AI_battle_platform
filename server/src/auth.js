import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCb);

const b64url = value => Buffer.from(value).toString('base64url');
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}
export async function verifyPassword(password, encoded) {
  const [scheme, saltText, hashText] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createToken(user, secret, ttlSeconds = 86400) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: user.id, email: user.email, iat: now, exp: now + ttlSeconds }));
  const unsigned = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}
export function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid bearer token');
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(unsigned).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid bearer token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!payload.sub || payload.exp <= Date.now() / 1000) throw new Error('Expired bearer token');
  return payload;
}
