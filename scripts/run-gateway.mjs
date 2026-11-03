import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { findNode } from './host-utils.mjs';
const child = spawn(findNode(), [resolve('node_modules/next/dist/bin/next'), process.argv[2] || 'build', 'apps/gateway', '--webpack'], { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
