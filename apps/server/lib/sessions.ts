import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile, rename, rm } from 'node:fs/promises';
import { atomicWrite, readJSON } from '../../../packages/execution-service/storage';
import { serverDataDir } from './environment';
import { HttpError, authVersion, loadUsers, tokenHash, equalHash, type UserRecord } from './auth-records';

export const SESSION_COOKIE = 'ae_chat_session';
export const ACCESS_TTL_MS = 15 * 60 * 1000;
interface WebSession { userId: string; version: string; expiresAt: number; }
interface ExtensionAccess { sessionHash: string; expiresAt: number; clientId: string; }
interface AuthorizationCode { sessionHash: string; clientId: string; redirectURI: string; challenge: string; expiresAt: number; }
const secretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const storagePath = (kind: string, hash: string) => join(serverDataDir(), 'auth', kind, `${hash}.json`);
const derive = promisify(scrypt);
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex'); const key = await derive(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password: string, stored?: string) {
  const valid = stored?.match(/^([a-f0-9]{32}):([a-f0-9]{128})$/);
  const key = await derive(password, valid?.[1] ?? '00000000000000000000000000000000', 64) as Buffer;
  return Boolean(valid && timingSafeEqual(key, Buffer.from(valid[2], 'hex')));
}
const attempts = new Map<string, { count: number; resetAt: number }>();
export async function verifyPassword(id: string, password: string) {
  const now = Date.now(); for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
  if (attempts.size >= 10000 && !attempts.has(id)) throw new HttpError(429, '登录请求过多，请稍后重试');
  let bucket = attempts.get(id); if (!bucket) { bucket = { count: 0, resetAt: now + 600000 }; attempts.set(id, bucket); }
  if (++bucket.count > 10) throw new HttpError(429, '登录尝试过多，请十分钟后再试');
  const user = (await loadUsers()).find(u => u.id === id && !u.disabled);
  if (!(await passwordMatches(password, user?.passwordHash)) || !user) throw new HttpError(401, '账号或密码不正确');
  attempts.delete(id); return user;
}
export async function createWebSession(user: UserRecord) {
  const token = randomBytes(32).toString('base64url');
  const session: WebSession = { userId: user.id, version: authVersion(user), expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
  await atomicWrite(storagePath('sessions', tokenHash(token)), session); return { token, ...session };
}
export function cookieToken(request: Request): string | undefined {
  return request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
async function readSessionHash(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(401, '请先登录服务网页');
  const session = await readJSON<WebSession | null>(storagePath('sessions', hash), null);
  if (!session || session.expiresAt <= Date.now()) throw new HttpError(401, '网页登录已过期，请重新登录');
  const user = (await loadUsers()).find(u => u.id === session.userId && !u.disabled);
  if (!user || !equalHash(authVersion(user), session.version)) throw new HttpError(401, '登录已失效，请重新登录');
  return { user, session, sessionHash: hash };
}
export async function webSession(token?: string) { if (!token || !secretPattern.test(token)) throw new HttpError(401, '请先登录服务网页'); return readSessionHash(tokenHash(token)); }
export async function revokeWebSession(token?: string) { if (token && secretPattern.test(token)) await rm(storagePath('sessions', tokenHash(token)), { force: true }); }
export async function extensionUser(token: string) {
  const access = await readJSON<ExtensionAccess | null>(storagePath('access', tokenHash(token)), null);
  if (!access || access.expiresAt <= Date.now()) throw new HttpError(401, '扩展登录已过期，请恢复网页登录');
  return (await readSessionHash(access.sessionHash)).user;
}
export function extensionClient(clientId: string, redirectURI: string) {
  const allowed = (process.env.AE_CHAT_EXTENSION_IDS || '').split(',').map(s => s.trim());
  if (!/^[a-p]{32}$/.test(clientId) || !allowed.includes(clientId) || redirectURI !== `https://${clientId}.chromiumapp.org/ae-auth`) throw new HttpError(400, '扩展授权回调无效');
}
export async function createAuthorization(sessionHash: string, clientId: string, redirectURI: string, challenge: string) {
  extensionClient(clientId, redirectURI);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new HttpError(400, '授权校验参数无效');
  await readSessionHash(sessionHash);
  const code = randomBytes(32).toString('base64url');
  await atomicWrite(storagePath('codes', tokenHash(code)), { sessionHash, clientId, redirectURI, challenge, expiresAt: Date.now() + 60000 } satisfies AuthorizationCode);
  return code;
}
export async function exchangeAuthorization(code: string, verifier: string, clientId: string, redirectURI: string) {
  extensionClient(clientId, redirectURI);
  if (!secretPattern.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new HttpError(400, '授权参数无效');
  const path = storagePath('codes', tokenHash(code)), consumed = `${path}.${randomBytes(8).toString('hex')}.used`;
  try { await rename(path, consumed); } catch { throw new HttpError(401, '授权码已失效或已使用'); }
  let value: AuthorizationCode;
  try { value = JSON.parse(await readFile(consumed, 'utf8')); } finally { await rm(consumed, { force: true }); }
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  if (value.expiresAt <= Date.now() || value.clientId !== clientId || value.redirectURI !== redirectURI || value.challenge !== challenge) throw new HttpError(401, '授权校验失败，请重新登录');
  const { session, user } = await readSessionHash(value.sessionHash);
  const token = `ae_ext_${randomBytes(32).toString('base64url')}`, expiresAt = Math.min(Date.now() + ACCESS_TTL_MS, session.expiresAt);
  await atomicWrite(storagePath('access', tokenHash(token)), { sessionHash: value.sessionHash, expiresAt, clientId } satisfies ExtensionAccess);
  return { token, expiresAt, user: { id: user.id } };
}
