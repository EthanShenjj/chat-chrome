import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { HostConfigSchema, defaultConfig, type HostConfig } from '../../packages/contracts/index';
import { executionContext } from './context';
export const dataDir = process.env.AE_CHAT_DATA_DIR || join(homedir(), '.ae-chat-agent');
export const getDataDir = () => executionContext()?.dataDir ?? dataDir;
export async function atomicWrite(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function readJSON<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function readConfig(): Promise<HostConfig> { return HostConfigSchema.parse(await readJSON(join(getDataDir(), 'config.json'), defaultConfig)); }
export async function writeConfig(value: unknown) { const config = HostConfigSchema.parse(value); await atomicWrite(join(getDataDir(), 'config.json'), config); return config; }
export async function credential(ref: string, secret?: string): Promise<string> {
  if (!/^[\w.-]+$/.test(ref)) throw new Error('无效的凭证引用');
  const context = executionContext();
  if (context) {
    const path = join(context.dataDir, 'credentials', `${ref}.json`);
    const key = createHash('sha256').update(context.encryptionKey).update(`:${context.userId}`).digest();
    const aad = Buffer.from(`${context.userId}:${ref}`);
    if (secret !== undefined) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      await atomicWrite(path, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      return '';
    }
    const value = await readJSON<any>(path, null); if (!value) throw new Error(`服务端尚未保存凭证 ${ref}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
  const environmentValue = process.env[`AE_CHAT_KEY_${ref.replace(/[-.]/g, '_')}`];
  if (secret === undefined && environmentValue) return environmentValue;
  if (process.platform !== 'darwin') {
    if (secret !== undefined) throw new Error('此版本仅支持 macOS 钥匙串写入；其他系统请设置 AE_CHAT_KEY_<引用> 环境变量');
    const value = process.env[`AE_CHAT_KEY_${ref.replace(/[-.]/g, '_')}`];
    if (!value) throw new Error(`未配置凭证 ${ref}`); return value;
  }
  const args = secret !== undefined ? ['add-generic-password', '-U', '-s', 'com.ae.chat.agent', '-a', ref, '-w', secret] : ['find-generic-password', '-s', 'com.ae.chat.agent', '-a', ref, '-w'];
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', c => output += c); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`钥匙串凭证 ${ref} ${secret !== undefined ? '保存失败' : '不可用'}`)));
  });
}
