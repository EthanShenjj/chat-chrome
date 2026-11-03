import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Sandbox } from '@vercel/sandbox';

// Use a project-scoped OIDC token written by `vercel link`, not a personal token.
for (const file of ['.env.local', '.env.production.local']) {
  try { process.loadEnvFile(resolve(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const { sandboxRoot, workerEnvironment, startWorker } = await import('../apps/gateway/lib/sandbox.ts');
workerEnvironment();
await mkdir('release', { recursive: true });
const archivePath = resolve('release/worker.tar.gz');
execFileSync('tar', ['-czf', archivePath, '-C', 'apps/server/.next/standalone', '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const archive = await readFile(archivePath), revision = createHash('sha256').update(archive).digest('hex').slice(0, 24);
console.log(`Prepared execution bundle: ${Math.ceil(archive.length / 1024 / 1024)} MiB`);
const sandboxName = process.env.AE_CHAT_SANDBOX_NAME || 'chat-chrome-production';
let sandbox = await Sandbox.getOrCreate({
  name: sandboxName,
  image: 'vercel/sandbox/universal', ports: [3000],
  timeout: 30 * 60 * 1000, resources: { vcpus: 1 },
  persistent: true, snapshotExpiration: 0, keepLastSnapshots: { count: 1, expiration: 0 },
  resume: true
});
async function run(cmd, args, extra = {}) {
  const result = await sandbox.runCommand({ cmd, args, ...extra });
  if (result.exitCode !== 0) throw new Error(`Provisioning command failed: ${cmd}`);
  return result;
}
const release = `${sandboxRoot}/releases/${revision}`;
console.log(`Persistent sandbox ready: ${sandbox.name}`);
await run('mkdir', ['-p', release, `${sandboxRoot}/data`]);
await sandbox.writeFiles([{ path: `${sandboxRoot}/worker.tar.gz`, content: archive }]);
console.log('Execution bundle uploaded.');
await run('tar', ['-xzf', `${sandboxRoot}/worker.tar.gz`, '-C', release]);
await run('node', ['-e', `
  const fs = require('node:fs'), path = '${sandboxRoot}/data/users.json';
  if (!fs.existsSync(path)) {
    const record = JSON.parse(process.env.AE_CHAT_BOOTSTRAP_RECORD || 'null');
    if (!record?.passwordHash || !record?.id || !record?.authVersion) process.exit(2);
    fs.writeFileSync(path, JSON.stringify([record]), { mode: 0o600, flag: 'wx' });
  }
`], { env: { AE_CHAT_BOOTSTRAP_RECORD: process.env.AE_CHAT_BOOTSTRAP_RECORD || '' } });
// Publish the release pointer before stopping. Concurrent gateway traffic may resume
// the VM immediately; its onResume hook must already point to the new code.
await run('sh', ['-c', `ln -sfn '${release}' '${sandboxRoot}/next'; mv -Tf '${sandboxRoot}/next' '${sandboxRoot}/current'`]);
// Snapshot prepared files and stop the old process using Sandbox's own lifecycle.
await sandbox.stop();
sandbox = await Sandbox.get({ name: sandboxName, resume: true });
await startWorker(sandbox);
console.log(`Execution service ready: ${sandbox.name} (${revision})`);
