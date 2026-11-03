import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliAuthorization } from '../packages/execution-service/cli-auth';
import { withExecutionContext, type ExecutionContext } from '../packages/execution-service/context';
import { readConfig, writeConfig, credential } from '../packages/execution-service/storage';
import { aeCredentialRef, runCli } from '../packages/execution-service/cli-runner';
const origin = 'https://ae.example.com';
const scope = { origin, projectId: '2', actorId: '42', tenantId: '7' };
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ae-cli-auth-')); folders.push(dataDir);
  const context: ExecutionContext = { userId: 'alice', dataDir, encryptionKey: 'x'.repeat(32), allowedOrigins: [origin], stdioCommands: {} };
  await withExecutionContext(context, () => writeConfig({ cliPath: resolve('tests/fixtures/cloud-cli.mjs'), aeOrigin: origin, binding: scope, providers: [], mcps: [] }));
  return { context, auth: new CliAuthorization(), run: <T>(fn: () => T) => withExecutionContext(context, fn) };
}
function deviceServer(options: { tokenError?: string; wrongActor?: boolean; unsupported?: boolean } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin); expect(init?.redirect).toBe('error');
    if (url.pathname.endsWith('/device/authorize')) return options.unsupported ? new Response('<html>Not found</html>', { status: 404 }) : Response.json({ device_code: 'private-device-code', user_code: 'ABCD-1234', expires_in: 300, interval: 1 });
    if (url.pathname.endsWith('/device/token')) { expect(JSON.parse(String(init?.body))).toEqual({ device_code: 'private-device-code' }); return options.tokenError ? Response.json({ error: options.tokenError }, { status: options.tokenError === 'access_denied' ? 403 : 400 }) : Response.json({ access_token: 'private-oauth-token' }); }
    if (url.pathname === '/v1/oauth/check') return Response.json({ return_code: 0, data: { userId: options.wrongActor ? 99 : 42, loginName: 'ae-alice', projectInfoList: [{ projectId: 2, companyId: 7 }] } });
    if (url.pathname.endsWith('/token/generate')) { expect(new Headers(init?.headers).get('Authorization')).toBe('bearer private-oauth-token'); return Response.json({ return_code: 0, data: { userSecret: 'cli_private-generated-token' } }); }
    if (url.pathname.endsWith('/token/validate')) { expect(new Headers(init?.headers).get('cli-token')).toBe('cli_private-generated-token'); return Response.json({ return_code: 0, data: { openId: 'external-account-id', loginName: 'ae-alice', userName: 'Alice' } }); }
    throw new Error(`Unexpected auth endpoint ${url.pathname}`);
  });
}
it('authorizes the bound AE account, encrypts credentials, and makes them available to isolated CLI commands', async () => {
  const f = await fixture(), network = deviceServer();
  await f.run(async () => {
    const pending = await f.auth.start(); expect(pending.status).toBe('pending');
    expect(pending.verificationURL).toBe(`${origin}/agent/device-activate?user_code=ABCD-1234`);
    expect(JSON.stringify(pending)).not.toMatch(/private-device|private-oauth|cli_private/);
    expect((await new CliAuthorization().view()).status).toBe('pending'); // resumes after worker restart
    const done = await new CliAuthorization().check(); expect(done).toMatchObject({ status: 'authenticated', accountName: 'ae-alice', origin });
    expect(await credential(aeCredentialRef(origin))).toBe('cli_private-generated-token');
    expect((await readConfig()).aeAuthScope).toEqual(scope);
    expect(JSON.stringify(done)).not.toMatch(/private-device|private-oauth|cli_private/);
    expect(await readFile(join(f.context.dataDir, 'credentials', `${aeCredentialRef(origin)}.json`), 'utf8')).not.toContain('cli_private');
    const cli = await runCli(resolve('tests/fixtures/cloud-cli.mjs'), ['--host', origin, '--format', 'json', 'auth', 'status']) as any;
    expect(cli.authenticated).toBe(true); expect(cli.masterKeyExposed).toBe(false);
    expect((await f.auth.status()).status).toBe('authenticated');
    expect((await f.auth.cancel()).status).toBe('authenticated'); // a late cancel must not pretend to revoke a completed grant
    expect(network.mock.calls.filter(([url]) => String(url).endsWith('/device/authorize'))).toHaveLength(1);
  });
});
it.each(['authorization_pending', 'slow_down'])('keeps %s pending and observes the polling interval', async tokenError => {
  const f = await fixture(), network = deviceServer({ tokenError });
  await f.run(async () => {
    await f.auth.start(); expect((await f.auth.check()).status).toBe('pending');
    await f.auth.check();
    expect(network.mock.calls.filter(([url]) => String(url).endsWith('/device/token'))).toHaveLength(1);
    expect((await f.auth.start()).status).toBe('pending');
  });
});
it('does not save a grant from a different AE account', async () => {
  const f = await fixture(); deviceServer({ wrongActor: true });
  await f.run(async () => { await f.auth.start(); expect((await f.auth.check()).status).toBe('account-mismatch'); await expect(credential(aeCredentialRef(origin))).rejects.toThrow('尚未保存'); });
});
it.each([['expired_token', 'expired'], ['access_denied', 'denied']])('reports terminal %s without leaking credentials', async (tokenError, status) => {
  const f = await fixture(); deviceServer({ tokenError });
  await f.run(async () => { await f.auth.start(); expect((await f.auth.check()).status).toBe(status); expect((await f.auth.view()).status).toBe(status); });
});
it('cancels pending authorization when the bound AE identity changes', async () => {
  const f = await fixture(), network = deviceServer();
  await f.run(async () => { await f.auth.start(); const config = await readConfig(); await writeConfig({ ...config, binding: { ...scope, actorId: '99' } }); expect((await f.auth.check()).status).toBe('account-mismatch'); expect(network.mock.calls.filter(([url]) => String(url).endsWith('/device/token'))).toHaveLength(0); });
});
it('supports cancellation and isolates pending grants between service users', async () => {
  const a = await fixture(), b = await fixture(), network = deviceServer();
  await a.run(() => a.auth.start()); expect((await b.run(() => b.auth.view())).status).toBe('not-authorized');
  await a.run(async () => { expect((await a.auth.cancel()).status).toBe('cancelled'); expect((await a.auth.check()).status).toBe('cancelled'); });
  expect(network.mock.calls.filter(([url]) => String(url).endsWith('/device/token'))).toHaveLength(0);
});
it('reports an unsupported device-login server and rejects non-allowlisted environments', async () => {
  const f = await fixture(), network = deviceServer({ unsupported: true });
  await f.run(async () => { expect((await f.auth.start()).status).toBe('error'); });
  expect((await f.run(() => f.auth.view())).message).toContain('设备码');
  const count = network.mock.calls.length;
  await withExecutionContext({ ...f.context, allowedOrigins: [] }, async () => { await expect(f.auth.start()).rejects.toThrow('管理员授权'); });
  expect(network.mock.calls).toHaveLength(count);
});
it('reports a cloud connection timeout without exposing private request details', async () => {
  const f = await fixture();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('private upstream detail', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }));
  await f.run(async () => { const state = await f.auth.start(); expect(state.status).toBe('error'); expect(state.message).toContain('443'); expect(JSON.stringify(state)).not.toContain('private upstream'); });
});
