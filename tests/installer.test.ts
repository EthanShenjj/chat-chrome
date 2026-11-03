import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CliInstaller } from '../packages/execution-service/installer/index';
import { readConfig } from '../packages/execution-service/storage';
import { withExecutionContext, type ExecutionContext } from '../packages/execution-service/context';
it('installs only an approved exact CLI version into the server user workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ae-installer-test-'));
  const context: ExecutionContext = { userId: 'installer', dataDir: dir, encryptionKey: 'test-encryption-key-32-characters-long', allowedOrigins: [], stdioCommands: {} };
  const original = process.env.AE_CHAT_NPM_CLI; process.env.AE_CHAT_NPM_CLI = resolve('tests/fixtures/fake-npm.mjs');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => { expect(String(url)).toBe('https://registry.npmjs.org/@thinkingai%2fae-cli/6.1.19'); return Response.json({ name: '@thinkingai/ae-cli', version: '6.1.19', dist: { integrity: 'sha512-fixture-integrity', tarball: 'https://registry.npmjs.org/@thinkingai/ae-cli/-/ae-cli-6.1.19.tgz' } }); });
  try {
    await withExecutionContext(context, async () => {
      const installer = new CliInstaller(); await expect(installer.plan('^6')).rejects.toThrow();
      const plan = await installer.plan('6.1.19'); expect(plan.destination.startsWith(dir)).toBe(true); expect(plan.modifiesGlobalCli).toBe(false);
      await expect(installer.install(plan.planId)).rejects.toThrow('确认'); installer.approve(plan.planId);
      const result = await installer.install(plan.planId); expect(result.version).toBe('6.1.19'); expect((await readConfig()).cliPath).toBe(result.executable);
      const record = JSON.parse(await readFile(join(dir, 'cli-installation.json'), 'utf8')); expect(record.integrity).toBe(plan.integrity);
      await expect(installer.install(plan.planId)).rejects.toThrow('确认');
    });
  } finally { fetchMock.mockRestore(); if (original === undefined) delete process.env.AE_CHAT_NPM_CLI; else process.env.AE_CHAT_NPM_CLI = original; await rm(dir, { recursive: true, force: true }); }
});
it('rejects installation metadata from an unapproved package source', async () => {
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ name: 'other-cli', version: '6.1.19', dist: { integrity: 'sha512-test', tarball: 'https://evil.example/cli.tgz' } }));
  try { await expect(new CliInstaller().plan('6.1.19')).rejects.toThrow('来源'); } finally { mock.mockRestore(); }
});
