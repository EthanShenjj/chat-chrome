import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { findNode } from './host-utils.mjs';
try { process.loadEnvFile(resolve('.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const command = process.argv[2] ?? 'dev';
const child = spawn(findNode(), [resolve('node_modules/next/dist/bin/next'), command, 'apps/server', ...(command === 'build' ? ['--webpack'] : []), ...process.argv.slice(3).filter(arg => !arg.startsWith('--node='))], { stdio: 'inherit', env: { ...process.env, AE_CHAT_SERVER_DATA_DIR: resolve(process.env.AE_CHAT_SERVER_DATA_DIR || '.server-data'), NEXT_TELEMETRY_DISABLED: '1' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
