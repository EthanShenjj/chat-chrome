import { randomBytes, createHash, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
try { process.loadEnvFile(resolve('.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const id = process.argv.find(v => v.startsWith('--id='))?.slice(5);
if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('用法：npm run server:user -- --id=alice [--password-stdin] [--revoke]');
const dir = resolve(process.env.AE_CHAT_SERVER_DATA_DIR || '.server-data'), path = join(dir, 'users.json');
await mkdir(dir, { recursive: true, mode: 0o700 });
let users = []; try { users = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const token = randomBytes(32).toString('base64url');
let supplied = ''; if (process.argv.includes('--password-stdin')) for await (const chunk of process.stdin) supplied += chunk;
const password = process.argv.includes('--password-stdin') ? supplied.trimEnd() : randomBytes(15).toString('base64url');
if (password.length < 10 || password.length > 256) throw new Error('密码长度需为 10–256 字符');
const salt = randomBytes(16).toString('hex');
const record = { id, tokenHash: createHash('sha256').update(token).digest('hex'), passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, authVersion: randomBytes(32).toString('hex'), disabled: process.argv.includes('--revoke') };
users = [...users.filter(u => u.id !== id), record]; const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 }); await rename(temp, path);
if (record.disabled) console.log(`用户 ${id} 已撤销访问。`);
else console.log(`账号：${id}\n${process.argv.includes('--password-stdin') ? '密码已从标准输入设置。' : `初始密码（仅显示一次）：${password}`}\n请在服务网页 /login 登录；扩展会自动接续登录。\n对同一用户再次运行此命令会重置密码并撤销原有会话。`);
