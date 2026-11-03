import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readJSON } from '../../../packages/execution-service/storage';
import { serverDataDir } from './environment';
export interface UserRecord { id: string; tokenHash: string; passwordHash?: string; authVersion?: string; disabled?: boolean; }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const authVersion = (user: UserRecord) => tokenHash([user.authVersion ?? '', user.tokenHash, user.passwordHash ?? ''].join(':'));
export const loadUsers = () => readJSON<UserRecord[]>(join(serverDataDir(), 'users.json'), []);
export function equalHash(a: string, b: string) { return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
const requests = new Map<string, { count: number; resetAt: number }>();
export function rateLimitUser(id: string) {
  const now = Date.now(), bucket = requests.get(id);
  if (!bucket || bucket.resetAt <= now) requests.set(id, { count: 1, resetAt: now + 60000 });
  else if (++bucket.count > 180) throw new HttpError(429, '请求过于频繁，请稍后重试');
}
