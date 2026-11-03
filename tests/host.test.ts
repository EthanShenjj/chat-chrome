import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
let dir: string, service: import('../packages/execution-service/service').HostService;
const scope = { origin: 'https://ae.example.com', projectId: '7', actorId: 'alice' };
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ae-chat-host-test-')); process.env.AE_CHAT_DATA_DIR = dir; process.env.AE_CHAT_FAKE_STATE = join(dir, 'fake-state.json');
  await chmod(resolve('tests/fixtures/fake-cli.mjs'), 0o755);
  const { HostService } = await import('../packages/execution-service/service'); service = new HostService();
  await service.dispatch('config.set', { cliPath: resolve('tests/fixtures/fake-cli.mjs'), binding: scope, providers: [], mcps: [] });
});
afterAll(async () => { await service.mcp.close(); await rm(dir, { recursive: true, force: true }); });
const call = (tool: string, args: unknown, operationId = randomUUID(), target = scope) => service.dispatch('ae.execute', { tool, args, operationId, taskId: 'task-test', scope: target }) as Promise<any>;
it('confirms writes with readback and deduplicates the same operation ID', async () => {
  const id = randomUUID(); const first = await call('ae.report.update', { reportId: 42, version: 3, name: '新支付报表' }, id);
  expect(first.event.afterVersion).toBe('4'); expect(first.event.changedPaths).toContain('/name');
  const replay = await call('ae.report.update', { reportId: 42, version: 3, name: '新支付报表' }, id);
  expect(replay.event.eventId).toBe(first.event.eventId); expect(JSON.parse(await readFile(process.env.AE_CHAT_FAKE_STATE!, 'utf8')).writes).toBe(1);
});
it('rejects stale versions before dispatching a write', async () => { await expect(call('ae.report.update', { reportId: 42, version: 3, name: 'stale' })).rejects.toThrow('版本冲突'); expect(JSON.parse(await readFile(process.env.AE_CHAT_FAKE_STATE!, 'utf8')).writes).toBe(1); });
it('rejects wrong project bindings and arbitrary native methods', async () => { await expect(call('ae.report.get', { reportId: 42 }, randomUUID(), { ...scope, projectId: '8' })).rejects.toThrow('绑定'); await expect(service.dispatch('shell.exec', { command: 'echo unsafe' })).rejects.toThrow('未授权'); });
it('persists unknown writes and refuses to replay after service restart', async () => { const id = randomUUID(); await expect(call('ae.report.update', { reportId: 42, version: 4, name: 'ambiguous' }, id)).rejects.toThrow('待核实'); const { HostService } = await import('../packages/execution-service/service'); const restarted = new HostService(); await expect(restarted.dispatch('ae.execute', { tool: 'ae.report.update', args: { reportId: 42, version: 4, name: 'ambiguous' }, operationId: id, taskId: 'test', scope })).rejects.toThrow('不会重复执行'); const records = await restarted.operations(); expect(records.find(o => o.id === id)?.state).toBe('unknown'); expect(JSON.parse(await readFile(process.env.AE_CHAT_FAKE_STATE!, 'utf8')).writes).toBe(2); });
it('validates config before persisting and requires explicit installer approval', async () => { await expect(service.dispatch('config.set', { cliPath: 'ae-cli', binding: { ...scope, origin: 'https://ae.example.com/path' }, providers: [], mcps: [] })).rejects.toThrow('origin'); const c: any = await service.dispatch('config.get'); expect(c.cliPath).toBe(resolve('tests/fixtures/fake-cli.mjs')); await expect(service.dispatch('cli.install', { planId: 'not-approved' })).rejects.toThrow('确认'); });
