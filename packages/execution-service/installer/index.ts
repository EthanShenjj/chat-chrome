import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getDataDir, readConfig, writeConfig, atomicWrite } from '../storage';
import { runProcess } from '../cli-runner/index';
export const CLI_PACKAGE = '@thinkingai/ae-cli';
const registry = 'https://registry.npmjs.org';
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
export class CliInstaller {
  private plans = new Map<string, { version: string; destination: string; integrity: string; expires: number; approved: boolean }>();
  async plan(version?: string) {
    if (version) Version.parse(version);
    const response = await fetch(`${registry}/@thinkingai%2fae-cli/${version ?? 'latest'}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`无法读取 AE CLI 安装信息：HTTP ${response.status}`);
    const data = await response.json() as any;
    Version.parse(data.version);
    if (data.name !== CLI_PACKAGE || !data.dist?.integrity || !String(data.dist.tarball).startsWith(`${registry}/@thinkingai/ae-cli/`)) throw new Error('安装包来源或完整性信息无效');
    const id = randomUUID(), destination = join(getDataDir(), 'cli', data.version, id);
    const plan = { version: data.version, destination, integrity: data.dist.integrity, expires: Date.now() + 600000, approved: false };
    this.plans.set(id, plan);
    return { planId: id, package: CLI_PACKAGE, version: plan.version, source: registry, destination, integrity: plan.integrity, lifecycleScripts: false, modifiesGlobalCli: false };
  }
  approve(id: string) { const plan = this.plans.get(id); if (!plan || plan.expires < Date.now()) throw new Error('安装计划已过期'); plan.approved = true; return { approved: true }; }
  async install(id: string) {
    const plan = this.plans.get(id); if (!plan?.approved || plan.expires < Date.now()) throw new Error('安装需要用户确认有效计划');
    this.plans.delete(id);
    const npm = [process.env.AE_CHAT_NPM_CLI, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(p => p && existsSync(p));
    if (!npm) throw new Error('执行器缺少随包交付的 npm 安装运行时，请重新安装执行器');
    await mkdir(plan.destination, { recursive: true, mode: 0o700 });
    const result = await runProcess(process.execPath, [npm, 'install', '--prefix', plan.destination, '--registry', registry, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--cache', join(getDataDir(), 'npm-cache'), `${CLI_PACKAGE}@${plan.version}`], 300000);
    if (result.code !== 0) throw new Error(`AE CLI 安装失败：${result.stderr.slice(-3000)}`);
    const lock = JSON.parse(await readFile(join(plan.destination, 'package-lock.json'), 'utf8'));
    if (lock.packages?.[`node_modules/${CLI_PACKAGE}`]?.integrity !== plan.integrity) throw new Error('下载的 AE CLI 完整性与确认的安装计划不一致，未启用');
    const executable = join(plan.destination, 'node_modules/.bin/ae-cli');
    const probe = await runProcess(executable, ['--version'], 20000);
    if (probe.code !== 0 || probe.stdout.trim() !== plan.version) throw new Error('AE CLI 已下载但版本探测未通过，未启用');
    const config = await readConfig(); config.cliPath = executable; await writeConfig(config);
    const record = { package: CLI_PACKAGE, ...plan, approved: undefined, executable, installedAt: Date.now() };
    await atomicWrite(join(getDataDir(), 'cli-installation.json'), record);
    return { installed: true, version: plan.version, executable, source: registry };
  }
}
