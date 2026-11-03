import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export function option(name) { return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3); }
export function findNode() {
  const candidates = [option('node'), process.execPath];
  const nvm = join(homedir(), '.nvm/versions/node');
  if (existsSync(nvm)) for (const version of readdirSync(nvm).sort().reverse()) candidates.push(join(nvm, version, 'bin/node'));
  for (const path of candidates.filter(Boolean)) { try { if (Number(execFileSync(path, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).trim()) >= 22) return resolve(path); } catch {} }
  throw new Error('需要 Node.js 22+ 来制作独立运行时。可用 --node=/path/to/node 指定；安装后的用户无需另装 Node。');
}
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
