import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../packages/execution-service/storage';
import { login, logout, authorize, exchange, sessionStatus } from '../apps/server/lib/login-http';
import { authenticate, tokenHash } from '../apps/server/lib/auth';
import { passwordHash, createWebSession, webSession, createAuthorization, exchangeAuthorization } from '../apps/server/lib/sessions';
let dir: string, user: { id: string; tokenHash: string; passwordHash: string }, cookie: string;
const origin = 'https://agent.example.com', id = 'a'.repeat(32), redirectURI = `https://${id}.chromiumapp.org/ae-auth`, verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const post = (path: string, data: unknown, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
beforeAll(async () => {
  delete process.env.AE_CHAT_ALLOW_LEGACY_TOKENS; delete process.env.AE_CHAT_PUBLIC_URL;
  dir = await mkdtemp(join(tmpdir(), 'ae-login-test-')); process.env.AE_CHAT_SERVER_DATA_DIR = dir; process.env.AE_CHAT_EXTENSION_IDS = id;
  user = { id: 'alice', tokenHash: tokenHash('legacy-api-token-for-test-only-long'), passwordHash: await passwordHash('correct-password-123') };
  await atomicWrite(join(dir, 'users.json'), [user]);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
it('blocks anonymous sessions and rejects incorrect passwords and cross-origin login', async () => {
  expect((await sessionStatus(new Request(`${origin}/api/auth/session`))).status).toBe(401);
  expect((await login(post('/api/auth/login', { id: 'alice', password: 'wrong' }))).status).toBe(401);
  expect((await login(post('/api/auth/login', { id: 'alice', password: 'correct-password-123' }, { Origin: 'https://evil.example.com' }))).status).toBe(403);
  await expect(authenticate(new Request(`${origin}/api/rpc`, { headers: { Authorization: 'Bearer legacy-api-token-for-test-only-long' } }))).rejects.toThrow('登录');
});
it('creates a protected HttpOnly website session and rejects cookie-authenticated cross-origin writes', async () => {
  const response = await login(post('/api/auth/login', { id: 'alice', password: 'correct-password-123' }));
  expect(response.status).toBe(200); const setCookie = response.headers.get('set-cookie')!; expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('Secure'); expect(setCookie).toContain('SameSite=Lax');
  cookie = setCookie.split(';')[0];
  const status = await sessionStatus(new Request(`${origin}/api/auth/session`, { headers: { Cookie: cookie } })); expect((await status.json()).user.id).toBe('alice');
  expect((await authenticate(post('/api/rpc', {}, { Cookie: cookie }))).id).toBe('alice');
  await expect(authenticate(post('/api/rpc', {}, { Cookie: cookie, Origin: 'https://evil.example.com' }))).rejects.toThrow('服务网页');
  const stored = await readFile(join(dir, 'users.json'), 'utf8'); expect(stored).not.toContain('correct-password-123');
});
it('requires a website login for authorization and rejects unregistered redirect targets', async () => {
  const query = new URLSearchParams({ client_id: id, redirect_uri: redirectURI, code_challenge: challenge, code_challenge_method: 'S256', state: 's'.repeat(43) });
  const guest = await authorize(new Request(`${origin}/api/auth/authorize?${query}`)); expect(guest.status).toBe(302); expect(new URL(guest.headers.get('location')!).pathname).toBe('/login');
  query.set('redirect_uri', 'https://evil.example.com/callback'); expect((await authorize(new Request(`${origin}/api/auth/authorize?${query}`, { headers: { Cookie: cookie } }))).status).toBe(400);
});
it('uses the public Host and forwarded protocol for same-origin login behind a proxy', async () => {
  const response = await login(new Request('http://localhost:3000/api/auth/login', { method: 'POST', headers: { Host: 'agent.example.com', Origin: origin, 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'alice', password: 'correct-password-123' }) }));
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Secure');
});
it('exchanges a PKCE-bound one-use code for an extension token and revokes it on website logout', async () => {
  const query = new URLSearchParams({ client_id: id, redirect_uri: redirectURI, code_challenge: challenge, code_challenge_method: 'S256', state: 's'.repeat(43) });
  const auth = await authorize(new Request(`${origin}/api/auth/authorize?${query}`, { headers: { Cookie: cookie } })); expect(auth.status).toBe(302);
  const callback = new URL(auth.headers.get('location')!); expect(callback.origin).toBe(`https://${id}.chromiumapp.org`); expect(callback.searchParams.get('state')).toBe('s'.repeat(43));
  const payload = { code: callback.searchParams.get('code'), verifier, clientId: id, redirectURI };
  const response = await exchange(post('/api/auth/token', payload, { Origin: `chrome-extension://${id}` })); expect(response.status).toBe(200); const access = await response.json();
  expect(access.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
  expect((await authenticate(new Request(`${origin}/api/rpc`, { headers: { Authorization: `Bearer ${access.token}` } }))).id).toBe('alice');
  expect((await exchange(post('/api/auth/token', payload, { Origin: `chrome-extension://${id}` }))).status).toBe(401);
  expect((await logout(post('/api/auth/logout', {}, { Cookie: cookie }))).status).toBe(200);
  await expect(authenticate(new Request(`${origin}/api/rpc`, { headers: { Authorization: `Bearer ${access.token}` } }))).rejects.toThrow();
});
it('rejects incorrect verifiers, expired sessions, and credential rotation', async () => {
  const session = await createWebSession(user), record = await webSession(session.token);
  const code = await createAuthorization(record.sessionHash, id, redirectURI, challenge);
  await expect(exchangeAuthorization(code, 'x'.repeat(43), id, redirectURI)).rejects.toThrow('校验失败');
  await atomicWrite(join(dir, 'auth/sessions', `${tokenHash(session.token)}.json`), { userId: 'alice', version: record.session.version, expiresAt: Date.now() - 1 });
  await expect(webSession(session.token)).rejects.toThrow('过期');
  const current = await createWebSession(user); await atomicWrite(join(dir, 'users.json'), [{ ...user, passwordHash: await passwordHash('rotated-password-123') }]);
  await expect(webSession(current.token)).rejects.toThrow('失效');
});
