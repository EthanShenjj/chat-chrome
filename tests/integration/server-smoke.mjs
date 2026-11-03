import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash, scryptSync } from 'node:crypto';
import { findNode } from '../../scripts/host-utils.mjs';
const root = await mkdtemp(join(tmpdir(), 'ae-next-e2e-'));
const token = randomBytes(32).toString('base64url');
const password = 'e2e-login-password-123'; const salt = randomBytes(16).toString('hex');
let context, next, model;
const logs = [], errors = [], modelCalls = [];
try {
  const extension = join(root, 'extension'); await cp(resolve('dist/extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  if (manifest.permissions.includes('nativeMessaging')) throw new Error('Cloud extension still requests native messaging');
  // Test fixture pregrants loopback access; production extension requests the chosen origin on user click.
  manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const executablePath = process.env.CHROMIUM_PATH || join(homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  context = await chromium.launchPersistentContext(join(root, 'profile'), { executablePath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1100, height: 900 } });
  context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const extensionId = new URL(worker.url()).host;
  model = createServer((req, res) => { let text = ''; req.on('data', c => text += c); req.on('end', () => {
    const body = JSON.parse(text); modelCalls.push(body);
    if (req.headers.authorization !== 'Bearer cloud-test-provider-key') { res.writeHead(401).end('{"error":{"message":"bad key"}}'); return; }
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'check', object: 'chat.completion', created: 1, model: 'cloud-test', choices: [{ index: 0, message: { role: 'assistant', content: body.tools ? null : 'OK', ...(body.tools ? { tool_calls: [{ id: 'test-call', type: 'function', function: { name: 'connection_check', arguments: '{"token":"ae-ok"}' } }] } : {}) }, finish_reason: body.tools ? 'tool_calls' : 'stop' }] })); return; }
    const afterTool = body.messages.some(m => m.role === 'tool');
    const chunk = (delta, finish = null) => ({ id: 'chat-next-test', object: 'chat.completion.chunk', created: 1, model: 'cloud-test', choices: [{ index: 0, delta, finish_reason: finish }] });
    const chunks = afterTool ? [chunk({ role: 'assistant', content: '服务器已完成 CLI 检测，' }), chunk({ content: '浏览器无需本地执行器。' }), chunk({}, 'stop')] : [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'cli-status-call', type: 'function', function: { name: 'ae_cli_status', arguments: '{}' } }] }), chunk({}, 'tool_calls')];
    res.setHeader('Content-Type', 'text/event-stream'); res.end(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n');
  }); });
  await new Promise((r, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', r); });
  const modelOrigin = `http://127.0.0.1:${model.address().port}`;
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r)); const url = `http://127.0.0.1:${port}`;
  const data = join(root, 'data'); await mkdir(data); await writeFile(join(data, 'users.json'), JSON.stringify([{ id: 'e2e-user', tokenHash: createHash('sha256').update(token).digest('hex'), passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}` }]));
  next = spawn(findNode(), [resolve('apps/server/.next/standalone/apps/server/server.js')], { env: { ...process.env, HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1', AE_CHAT_SERVER_DATA_DIR: data, AE_CHAT_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AE_CHAT_EXTENSION_IDS: extensionId, AE_CHAT_ALLOWED_ORIGINS: modelOrigin, AE_CHAT_STDIO_COMMANDS: '{}' }, stdio: ['ignore', 'pipe', 'pipe'] });
  next.stdout.on('data', c => logs.push(String(c))); next.stderr.on('data', c => logs.push(String(c)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {} if (i === 99) throw new Error('Next.js did not start'); await new Promise(r => setTimeout(r, 100)); }
  await mkdir('artifacts', { recursive: true });
  const home = await context.newPage(); await home.goto(url); await home.getByRole('heading', { name: /想法到报表/ }).waitFor(); await home.screenshot({ path: 'artifacts/cloud-home.png', fullPage: true });
  if (!(await fetch(`${url}/ae-chat-extension.zip`)).ok) throw new Error('Extension download unavailable');
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByRole('textbox', { name: '服务地址' }).fill(url);
  if (await page.getByRole('textbox', { name: '个人访问令牌' }).count()) throw new Error('Extension still asks for manual access tokens');
  await page.getByRole('button', { name: '保存服务地址', exact: true }).click();
  await page.getByRole('main').getByText('尚未登录服务网页', { exact: true }).waitFor();
  const anonymous = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'chat.send', text: 'must be blocked' }));
  if (anonymous.ok) throw new Error('Anonymous chat was accepted');
  const website = await context.newPage(); await website.goto(`${url}/workspace`);
  await website.getByRole('heading', { name: '登录工作区' }).waitFor();
  await website.screenshot({ path: 'artifacts/login.png', fullPage: true });
  await website.getByRole('textbox', { name: '账号', exact: true }).fill('e2e-user');
  await website.getByLabel('密码', { exact: true }).fill(password);
  await website.getByRole('button', { name: '登录', exact: true }).click();
  try { await website.getByRole('heading', { name: '让分析，顺着想法发生。' }).waitFor({ timeout: 10000 }); } catch (e) { console.log('Website URL:', website.url(), 'Visible content:', await website.locator('body').innerText(), 'Browser errors:', errors); await website.screenshot({ path: 'artifacts/login-failure.png' }); throw e; }
  await page.bringToFront();
  await page.getByRole('main').getByText('已登录 · e2e-user', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await page.getByRole('combobox', { name: '接口协议' }).selectOption('openai-chat-completions');
  await page.getByRole('textbox', { name: 'API 地址' }).fill(`${modelOrigin}/v1`);
  await page.getByRole('textbox', { name: '模型名称' }).fill('cloud-test');
  await page.getByRole('textbox', { name: 'API Key' }).fill('cloud-test-provider-key');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '模型配置已保存' }).waitFor();
  await page.getByRole('button', { name: '测试工具调用', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '工具调用通过' }).waitFor();
  await page.getByRole('navigation').getByRole('button', { name: '返回对话', exact: true }).click();
  await page.getByRole('textbox', { name: '消息' }).fill('检查服务器上的 AE CLI');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('服务器已完成 CLI 检测，浏览器无需本地执行器。', { exact: true }).waitFor({ timeout: 20000 });
  await page.reload(); await page.getByRole('button', { name: '返回对话', exact: true }).first().click(); await page.getByText('服务器已完成 CLI 检测，浏览器无需本地执行器。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 420, height: 900 }); await page.screenshot({ path: 'artifacts/cloud-sidepanel.png', fullPage: true });
  const saved = JSON.parse(await readFile(join(data, 'users/e2e-user/workspace.json'), 'utf8'));
  if (!saved.sessions.some(s => s.messages.some(m => m.text.includes('服务器已完成')))) throw new Error('Server session was not persisted');
  if (!modelCalls.some(body => body.messages?.some(m => m.role === 'tool'))) throw new Error('Agent tool loop did not run on server');
  const keyFile = await readFile(join(data, 'users/e2e-user/credentials/openai.json'), 'utf8'); if (keyFile.includes('cloud-test-provider-key')) throw new Error('Provider key stored without encryption');
  const connection = await page.evaluate(async () => (await chrome.storage.local.get('serviceConnection')).serviceConnection);
  if (!connection.token.startsWith('ae_ext_') || connection.token === token) throw new Error('Extension did not use a scoped web-login grant');
  await website.bringToFront(); await website.getByRole('button', { name: '设置', exact: true }).click();
  await website.getByRole('button', { name: '退出登录', exact: true }).click();
  await website.getByRole('heading', { name: '登录工作区' }).waitFor();
  await page.bringToFront(); await page.getByRole('heading', { name: '登录后，继续你的分析。' }).waitFor({ timeout: 20000 });
  if (!(await page.getByRole('textbox', { name: '消息' }).isDisabled())) throw new Error('Chat remained enabled after website logout');
  if (await page.getByText('服务器已完成 CLI 检测，浏览器无需本地执行器。', { exact: true }).count()) throw new Error('Private history remained visible after logout');
  const deniedAfterLogout = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'chat.send', text: 'must stay blocked' }));
  if (deniedAfterLogout.ok) throw new Error('Chat was accepted after logout');
  await website.bringToFront(); await website.getByRole('textbox', { name: '账号', exact: true }).fill('e2e-user'); await website.getByLabel('密码', { exact: true }).fill(password); await website.getByRole('button', { name: '登录', exact: true }).click();
  await website.getByRole('textbox', { name: '消息' }).waitFor(); await page.bringToFront();
  await page.getByText('服务器已完成 CLI 检测，浏览器无需本地执行器。', { exact: true }).waitFor({ timeout: 20000 });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ passed: true, checks: ['Next.js production server', 'extension download', 'HTTPS-compatible authenticated RPC', 'website password login and automatic extension authorization', 'anonymous chat rejection', 'website logout revokes extension access', 'private history cleared on logout', 'login resumes the same server conversation', 'model settings and encrypted key', 'capability test', 'server-side streamed tool loop', 'persisted conversation after page reload', 'no native messaging permission'], screenshots: ['artifacts/cloud-home.png', 'artifacts/cloud-sidepanel.png'] }, null, 2));
} catch (e) { console.error(logs.join('').slice(-5000)); throw e; }
finally { if (context) await context.close(); if (next && next.exitCode === null) { const stopped = new Promise(r => next.once('exit', r)); next.kill('SIGTERM'); await stopped; } if (model) await new Promise(r => model.close(r)); await rm(root, { recursive: true, force: true }); }
