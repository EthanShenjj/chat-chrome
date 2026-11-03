import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { rpc, events, options } from '../apps/server/lib/http';
import { tokenHash } from '../apps/server/lib/auth';
import { userContext } from '../apps/server/lib/environment';
import { getWorkspace } from '../apps/server/lib/workspace';
import { withExecutionContext } from '../packages/execution-service/context';
import { atomicWrite, credential, readConfig } from '../packages/execution-service/storage';
import { defaultProvider } from '../packages/contracts/index';
let dir: string, server: Server, origin: string;
const alice = randomBytes(32).toString('base64url'), bob = randomBytes(32).toString('base64url');
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ae-cloud-test-'));
  process.env.AE_CHAT_SERVER_DATA_DIR = dir; process.env.AE_CHAT_ENCRYPTION_KEY = 'server-test-encryption-key-32-characters-long'; process.env.AE_CHAT_TEST_GLOBAL_SECRET = 'do-not-inherit'; process.env.AE_CHAT_EXTENSION_IDS = 'a'.repeat(32); process.env.AE_CHAT_STDIO_COMMANDS = '{}';
  process.env.AE_CHAT_ALLOW_LEGACY_TOKENS = 'true';
  server = createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const body = JSON.parse(raw);
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'test', choices: [{ message: { role: 'assistant', content: 'OK', tool_calls: body.tools?.length ? [{ id: 'check', type: 'function', function: { name: 'connection_check', arguments: '{"token":"ae-ok"}' } }] : undefined }, finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }] })); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    const packet = (delta: unknown) => ({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: null }] });
    res.write(`data: ${JSON.stringify(packet({ role: 'assistant', content: '云端' }))}\n\n`);
    setTimeout(() => res.end(`data: ${JSON.stringify({ ...packet({ content: '回答' }), choices: [{ index: 0, delta: { content: '回答' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), 80);
  }); });
  await new Promise<void>((r, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', r); }); origin = `http://127.0.0.1:${(server.address() as any).port}`; process.env.AE_CHAT_ALLOWED_ORIGINS = origin;
  await atomicWrite(join(dir, 'users.json'), [{ id: 'alice', tokenHash: tokenHash(alice) }, { id: 'bob', tokenHash: tokenHash(bob) }]);
  await chmod(resolve('tests/fixtures/cloud-cli.mjs'), 0o755);
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
async function call(token: string, type: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await rpc(new Request('http://localhost:3000/api/rpc', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: extensionOrigin, ...headers }, body: JSON.stringify({ type, ...args }) })); return { response, body: await response.json() as any };
}
it('requires authentication, restricts extension origins, and rejects arbitrary dispatch', async () => {
  expect((await call('invalid', 'state.get')).response.status).toBe(401);
  expect((await call(alice, 'state.get', {}, { Origin: 'https://untrusted.example' })).response.status).toBe(403);
  expect((await call(alice, 'shell.exec')).body.ok).toBe(false);
  expect((await call(alice, 'credential.get', { ref: 'key' })).body.ok).toBe(false);
  expect(options(new Request('http://localhost/api/rpc', { headers: { Origin: extensionOrigin } })).status).toBe(204);
});
it('saves an AE origin without requiring manual account or project IDs', async () => {
  const saved = await call(bob, 'workspace.connect', { origin });
  expect(saved.body.ok).toBe(true);
  expect(saved.body.result.config.aeOrigin).toBe(origin);
  expect(saved.body.result.config.binding).toBeNull();
  expect((await call(bob, 'workspace.connect', { origin, scope: { origin: 'https://another.example', projectId: '2', actorId: '42' } })).body.ok).toBe(false);
});
it('does not reuse an AE CLI credential after the discovered account changes', async () => {
  const scope = { origin, projectId: '2', actorId: 'ae-user-42' };
  expect((await call(bob, 'workspace.connect', { origin, scope })).body.ok).toBe(true);
  expect((await call(bob, 'auth.save', { token: 'fixture-ae-token' })).body.ok).toBe(true);
  expect((await call(bob, 'workspace.connect', { origin, scope: { ...scope, actorId: 'ae-user-43' } })).body.ok).toBe(true);
  const check = await call(bob, 'auth.status');
  expect(check.body.ok).toBe(false); expect(check.body.error).toContain('账号或租户已变化');
});
it('isolates configuration and encrypted credentials between users', async () => {
  const initial = (await call(alice, 'state.get')).body.result;
  const config = { ...initial.config, providers: [{ ...defaultProvider, protocol: 'openai-chat-completions', id: 'test', baseURL: `${origin}/v1`, credentialRef: 'test', model: 'test' }] };
  expect((await call(alice, 'config.save', { config })).body.ok).toBe(true);
  expect((await call(alice, 'credential.save', { ref: 'test', secret: 'alice-provider-secret' })).body.ok).toBe(true);
  expect((await call(bob, 'state.get')).body.result.config.providers).toHaveLength(0);
  const encrypted = await readFile(join(dir, 'users/alice/credentials/test.json'), 'utf8'); expect(encrypted).not.toContain('alice-provider-secret');
  await expect(withExecutionContext(userContext('bob'), () => credential('test'))).rejects.toThrow('尚未保存');
  expect(await withExecutionContext(userContext('alice'), () => credential('test'))).toBe('alice-provider-secret');
});
it('enforces server endpoint and executable restrictions and performs capability testing', async () => {
  const config = (await call(alice, 'state.get')).body.result.config;
  expect((await call(alice, 'config.save', { config: { ...config, providers: [{ ...config.providers[0], baseURL: 'http://127.0.0.1:9/v1' }] } })).body.ok).toBe(false);
  expect((await call(alice, 'config.save', { config: { ...config, mcps: [{ id: 'bad', name: 'bad', enabled: true, transport: 'stdio', command: '/bin/sh', args: ['-c', 'whoami'], allowedTools: [] }] } })).body.ok).toBe(false);
  expect((await call(alice, 'config.save', { config: { ...config, cliPath: '/bin/sh', providers: [{ ...config.providers[0], capabilities: { ...config.providers[0].capabilities, toolCalling: true } }] } })).body.ok).toBe(true);
  const saved = (await call(alice, 'state.get')).body.result.config; expect(saved.cliPath).toBe('ae-cli'); expect(saved.providers[0].capabilities.toolCalling).toBe(false);
  expect((await call(alice, 'provider.test', { id: 'test', tools: true })).body.ok).toBe(true);
  expect((await call(alice, 'state.get')).body.result.config.providers[0].capabilities.toolCalling).toBe(true);
});
it('runs a server-side conversation independently of the event connection', async () => {
  expect((await call(alice, 'chat.send', { text: '你好' })).body.ok).toBe(true);
  expect((await call(alice, 'chat.send', { text: 'duplicate' })).body.ok).toBe(false);
  const controller = new AbortController();
  const response = await events(new Request('http://localhost/api/events', { headers: { Authorization: `Bearer ${alice}`, Origin: extensionOrigin }, signal: controller.signal }));
  expect(response.headers.get('Content-Type')).toContain('text/event-stream'); const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: state'); controller.abort(); await reader.cancel();
  let snapshot: any;
  for (let i = 0; i < 30; i++) { snapshot = (await call(alice, 'state.get')).body.result; if (snapshot.session.status !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
  expect(snapshot.session.status).toBe('idle'); expect(snapshot.session.messages.at(-1).text).toBe('云端回答'); expect((await call(bob, 'sessions.list')).body.result).toHaveLength(0);
});
it('gives CLI a temporary per-user HOME without server master keys, then cleans it up', async () => {
  const context = userContext('alice'), workspace = await getWorkspace(context);
  const scope = { origin, projectId: '7', actorId: 'alice' };
  await workspace.run(async () => { const c = await readConfig(); await workspace.host.dispatch('config.set', { ...c, cliPath: resolve('tests/fixtures/cloud-cli.mjs'), binding: scope }); });
  expect((await call(alice, 'auth.save', { token: 'ae-user-token' })).body.ok).toBe(true);
  const status = (await call(alice, 'auth.status')).body.result;
  expect(status.authenticated).toBe(true); expect(status.masterKeyExposed).toBe(false); expect(status.globalSecretExposed).toBe(false); expect(status.isolatedHome.startsWith(join(context.dataDir, 'tmp'))).toBe(true);
  await expect(readFile(join(status.isolatedHome, '.ae-config/cli-token.json'))).rejects.toThrow();
  const reply: any = await workspace.run(() => workspace.host.dispatch('ae.execute', { tool: 'ae.report.update', args: { reportId: 42, version: 3, name: '云端更新' }, operationId: randomUUID(), taskId: 'cloud-test', scope })); expect(reply.event.afterVersion).toBe('4');
  expect((await call(bob, 'state.get')).body.result.operations).toHaveLength(0);
});
it('rejects a revoked personal access token on subsequent requests', async () => { await atomicWrite(join(dir, 'users.json'), [{ id: 'alice', tokenHash: tokenHash(alice), disabled: true }, { id: 'bob', tokenHash: tokenHash(bob) }]); expect((await call(alice, 'state.get')).response.status).toBe(401); });
