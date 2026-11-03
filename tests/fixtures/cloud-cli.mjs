#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), file = join(process.cwd(), 'cloud-cli-state.json');
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { report_id: 42, version: 3, model_type: 'event', report_name: '支付报表', definition: { metrics: [{ event: 'pay' }] }, writes: 0 };
const flag = key => args[args.indexOf(key) + 1];
const out = data => process.stdout.write(JSON.stringify({ ok: true, data }));
if (args.includes('--version')) process.stdout.write('6.1.19\n');
else if (args.includes('auth')) out({ authenticated: existsSync(join(process.env.HOME, '.ae-config/cli-token.json')), isolatedHome: process.env.HOME, masterKeyExposed: Boolean(process.env.AE_CHAT_ENCRYPTION_KEY), globalSecretExposed: Boolean(process.env.AE_CHAT_TEST_GLOBAL_SECRET) });
else if (args.includes('url-get')) out({ url: `${flag('--host')}/#/tga/event/7_42` });
else if (args.includes('get')) out(state);
else if (args.includes('update')) { state.writes++; state.version++; if (args.includes('--report-name')) state.report_name = flag('--report-name'); writeFileSync(file, JSON.stringify(state)); out({ report_id: 42 }); }
else out({ items: [] });
