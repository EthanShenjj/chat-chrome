import { mkdir, copyFile, writeFile, cp, chmod, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { findNode } from './host-utils.mjs';
const name = `ae-chat-agent-${platform()}-${arch()}`, dir = `release/${name}`;
await mkdir(`${dir}/runtime`, { recursive: true }); await mkdir(`${dir}/scripts`, { recursive: true });
const node = findNode();
await copyFile(node, `${dir}/runtime/node`); await chmod(`${dir}/runtime/node`, 0o755);
await mkdir(`${dir}/runtime/node_modules`, { recursive: true });
await cp(resolve(node, '../../lib/node_modules/npm'), `${dir}/runtime/node_modules/npm`, { recursive: true });
await copyFile('dist/native-host/host.cjs', `${dir}/host.cjs`);
for (const file of ['install-host.mjs', 'host-utils.mjs']) await copyFile(`scripts/${file}`, `${dir}/scripts/${file}`);
await cp('dist/extension', `${dir}/extension`, { recursive: true });
await copyFile('README.md', `${dir}/README.md`);
await writeFile(`${dir}/install.sh`, '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec ./runtime/node ./scripts/install-host.mjs --bundled "$@"\n', { mode: 0o755 });
const notices = [];
async function collectPackage(path) {
  let meta; try { meta = JSON.parse(await readFile(`${path}/package.json`, 'utf8')); } catch { return; }
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isFile() && /^(license|licence|notice|copying)(\.|$)/i.test(entry.name)) notices.push(`\n===== ${meta.name}@${meta.version} / ${entry.name} =====\n${await readFile(`${path}/${entry.name}`, 'utf8')}`);
  try { await collectModules(`${path}/node_modules`); } catch {}
}
async function collectModules(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) {
    if (entry.name.startsWith('@')) { for (const child of await readdir(`${root}/${entry.name}`)) await collectPackage(`${root}/${entry.name}/${child}`); }
    else await collectPackage(`${root}/${entry.name}`);
  }
}
await collectModules('node_modules');
await collectPackage(`${dir}/runtime/node_modules/npm`);
notices.unshift(`===== Node.js runtime and bundled third-party notices =====\n${await readFile(resolve(node, '../../LICENSE'), 'utf8')}`);
await writeFile(`${dir}/THIRD_PARTY.txt`, notices.join('\n'));
await copyFile('package-lock.json', `${dir}/package-lock.json`);
execFileSync('tar', ['-czf', `release/${name}.tar.gz`, '-C', 'release', name], { stdio: 'inherit' });
console.log(`Packaged release/${name}.tar.gz (runtime included; no Node installation required)`);
