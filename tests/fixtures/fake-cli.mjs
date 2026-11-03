#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2), file = process.env.AE_CHAT_FAKE_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { report_id: 42, version: 3, model_type: 'event', report_name: '支付报表', definition: { metrics: [{ event: 'pay' }] }, writes: 0 };
const flag = key => args[args.indexOf(key) + 1];
const out = data => process.stdout.write(JSON.stringify({ ok: true, data }));
if (args.includes('--version')) process.stdout.write('6.1.19\n');
else if (args.includes('auth')) out({ authenticated: true });
else if (args.includes('url-get')) out({ url: 'https://ae.example.com/#/tga/event/7_42' });
else if (args.includes('get')) out(state);
else if (args.includes('create') || args.includes('update')) {
  if (flag('--report-name') === 'force-conflict') { process.stderr.write(JSON.stringify({ ok: false, error: { message: 'version conflict' } })); process.exit(1); }
  state.writes++; state.version++; if (args.includes('--definition')) state.definition = JSON.parse(flag('--definition')); if (args.includes('--report-name')) state.report_name = flag('--report-name');
  writeFileSync(file, JSON.stringify(state));
  if (flag('--report-name') === 'ambiguous') process.stdout.write('accepted but not confirmed'); else out({ report_id: 42 });
} else out({ items: [] });
