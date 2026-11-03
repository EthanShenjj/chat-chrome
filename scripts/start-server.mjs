import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { findNode } from './host-utils.mjs';
try { process.loadEnvFile(resolve('.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const child = spawn(findNode(), [resolve('apps/server/.next/standalone/apps/server/server.js')], { stdio: 'inherit', env: { ...process.env, AE_CHAT_SERVER_DATA_DIR: resolve(process.env.AE_CHAT_SERVER_DATA_DIR || '.server-data'), NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: process.env.HOSTNAME || '0.0.0.0' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
