import { spawn } from 'node:child_process';
import { CliError, parseEnvelope } from '../../../packages/ae-cli-adapter/index';
import { executionContext, childEnvironment } from '../context';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, credential } from '../storage';
import { readConfig } from '../storage';
import { sameAeIdentity } from '../../contracts/index';
export interface ProcessResult { stdout: string; stderr: string; code: number | null; }
export const aeCredentialRef = (origin: string) => `ae-${createHash('sha256').update(origin).digest('hex').slice(0, 24)}`;
export async function runProcess(executable: string, args: string[], timeout = 90000): Promise<ProcessResult> {
  const context = executionContext(), env = childEnvironment();
  let temporaryHome: string | undefined;
  if (context) {
    await mkdir(join(context.dataDir, 'tmp'), { recursive: true, mode: 0o700 });
    temporaryHome = await mkdtemp(join(context.dataDir, 'tmp', 'process-'));
    env.HOME = temporaryHome; env.XDG_CONFIG_HOME = join(temporaryHome, '.config');
    const hostIndex = args.indexOf('--host');
    if (hostIndex >= 0) {
      try { const token = await credential(aeCredentialRef(args[hostIndex + 1])); const config = await readConfig(); if (config.aeOrigin && (!config.binding || !sameAeIdentity(config.binding, config.aeAuthScope))) throw new Error('AE 账号或租户已变化，请为当前识别到的账号重新配置 CLI 授权'); await atomicWrite(join(temporaryHome, '.ae-config/cli-token.json'), { url: args[hostIndex + 1], token }); }
      catch (e) { if (!(e instanceof Error) || !e.message.includes('尚未保存')) { await rm(temporaryHome, { recursive: true, force: true }); throw e; } }
    }
  }
  try { return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env, cwd: context?.dataDir });
    let stdout = '', stderr = '', size = 0, issue: string | undefined;
    const kill = (message: string) => { issue = message; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); };
    const timer = setTimeout(() => kill('CLI 超时；写操作结果未知，请先核实资源'), timeout);
    child.stdout.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) kill('CLI 输出超过 8 MB；结果未知'); else stdout += c; });
    child.stderr.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) kill('CLI 输出超过 8 MB；结果未知'); else stderr += c; });
    child.on('error', e => { clearTimeout(timer); reject(new CliError(`无法启动 CLI：${e.message}`)); });
    child.on('close', code => { clearTimeout(timer); if (issue) reject(new CliError(issue, true)); else resolve({ stdout, stderr, code }); });
  }); } finally { if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true }); }
}
export async function runCli(path: string, args: string[]) { const r = await runProcess(path, args); return parseEnvelope(r.stdout, r.stderr, r.code); }
