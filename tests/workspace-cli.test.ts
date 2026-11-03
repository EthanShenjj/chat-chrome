import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CloudWorkspace } from '../apps/server/lib/workspace';
import { defaultProvider } from '../packages/contracts';

it.each([true, false])('automatically checks tool support and honors CLI installation approval (%s)', async approved => {
  const dir = await mkdtemp(join(tmpdir(), 'ae-chat-install-'));
  const workspace = new CloudWorkspace({ userId: 'installer', dataDir: dir, encryptionKey: 'test-encryption-key-32-characters-long', allowedOrigins: ['https://model.example'], stdioCommands: {} });
  const originalNpm = process.env.AE_CHAT_NPM_CLI; process.env.AE_CHAT_NPM_CLI = resolve('tests/fixtures/fake-npm.mjs');
  const requests: any[] = [];
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://registry.npmjs.org/')) return Response.json({ name: '@thinkingai/ae-cli', version: '6.1.19', dist: { integrity: 'sha512-fixture-integrity', tarball: 'https://registry.npmjs.org/@thinkingai/ae-cli/-/ae-cli-6.1.19.tgz' } });
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const last = body.messages.at(-1);
    const fn = body.tools?.some((t: any) => t.function.name === 'connection_check') ? { name: 'connection_check', arguments: '{"token":"ae-ok"}' }
      : last.role !== 'tool' && body.tools?.some((t: any) => t.function.name === 'ae_cli_install') ? { name: 'ae_cli_install', arguments: '{}' } : undefined;
    const content = last.role === 'tool' ? JSON.parse(last.content).installed ? '已安装' : '安装已取消' : '没有安装工具';
    return Response.json({ id: 'chat-test', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: fn ? null : content, ...(fn ? { tool_calls: [{ id: 'call-install', type: 'function', function: fn }] } : {}) }, finish_reason: fn ? 'tool_calls' : 'stop' }] });
  });
  try {
    const initial = await workspace.snapshot();
    await workspace.dispatch({ type: 'config.save', config: { ...initial.config, providers: [{ ...defaultProvider, id: 'test', baseURL: 'https://model.example/v1', protocol: 'openai-chat-completions', capabilities: { ...defaultProvider.capabilities, streaming: false, toolCalling: false } }] } });
    await workspace.dispatch({ type: 'credential.save', ref: defaultProvider.credentialRef, secret: 'fixture-key' });
    await workspace.dispatch({ type: 'chat.send', text: '在服务器安装 AE CLI' });
    let snapshot = await workspace.snapshot();
    for (let n = 0; n < 100 && !snapshot.approvals.length && snapshot.session.status === 'running'; n++) { await new Promise(r => setTimeout(r, 10)); snapshot = await workspace.snapshot(); }
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.config.cliPath).toBe('ae-cli');
    expect(snapshot.approvals[0].label).toContain('安装 AE CLI 6.1.19');
    await workspace.dispatch({ type: 'approval.resolve', id: snapshot.approvals[0].id, approved });
    for (let n = 0; n < 200 && snapshot.session.status === 'running'; n++) { await new Promise(r => setTimeout(r, 10)); snapshot = await workspace.snapshot(); }
    expect(snapshot.session.status).toBe('idle');
    expect(snapshot.session.messages.at(-1)?.text).toBe(approved ? '已安装' : '安装已取消');
    expect(snapshot.config.cliPath).toEqual(approved ? expect.stringContaining('/node_modules/.bin/ae-cli') : 'ae-cli');
    expect(snapshot.config.providers[0].capabilities.toolCalling).toBe(true);
    expect(requests.filter(r => r.tools?.some((t: any) => t.function.name === 'connection_check'))).toHaveLength(1);
  } finally {
    await workspace.dispatch({ type: 'chat.stop' });
    mock.mockRestore(); if (originalNpm === undefined) delete process.env.AE_CHAT_NPM_CLI; else process.env.AE_CHAT_NPM_CLI = originalNpm;
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps ordinary chat available and explains a failed automatic tool check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ae-chat-tools-'));
  const workspace = new CloudWorkspace({ userId: 'chat', dataDir: dir, encryptionKey: 'test-encryption-key-32-characters-long', allowedOrigins: ['https://model.example'], stdioCommands: {} });
  const requests: any[] = [];
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.tools?.length) return Response.json({ error: { message: 'This model does not support tools' } }, { status: 400 });
    return Response.json({ id: 'chat', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: '仍可对话' }, finish_reason: 'stop' }] });
  });
  try {
    const initial = await workspace.snapshot();
    await workspace.dispatch({ type: 'config.save', config: { ...initial.config, providers: [{ ...defaultProvider, id: 'chat', baseURL: 'https://model.example/v1', protocol: 'openai-chat-completions', capabilities: { ...defaultProvider.capabilities, streaming: false, toolCalling: false } }] } });
    await workspace.dispatch({ type: 'credential.save', ref: defaultProvider.credentialRef, secret: 'fixture-key' });
    await workspace.dispatch({ type: 'chat.send', text: '你好' });
    let snapshot = await workspace.snapshot();
    for (let n = 0; n < 100 && snapshot.session.status === 'running'; n++) { await new Promise(r => setTimeout(r, 10)); snapshot = await workspace.snapshot(); }
    expect(snapshot.session.status).toBe('idle');
    expect(snapshot.session.messages.at(-1)?.text).toBe('仍可对话');
    expect(snapshot.config.providers[0].capabilities.toolCalling).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1].tools ?? []).toHaveLength(0);
    expect(JSON.stringify(requests[1].messages)).toContain('This model does not support tools');
    expect(snapshot.approvals).toHaveLength(0);
  } finally { mock.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
