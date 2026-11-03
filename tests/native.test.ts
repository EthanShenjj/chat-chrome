import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameDecoder, frame } from '../apps/native-host/protocol';
import { NativeBridge } from './fixtures/legacy-native-bridge';
import { defaultProvider } from '../packages/contracts/index';
let dir: string, child: ChildProcessWithoutNullStreams, server: Server, bridge: NativeBridge, port: number;
const seen: { authorization?: string; body: any }[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ae-native-test-'));
  await build({ entryPoints: ['apps/native-host/index.ts'], outfile: join(dir, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'] });
  server = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { seen.push({ authorization: req.headers.authorization, body: JSON.parse(body) }); res.setHeader('Content-Type', 'text/event-stream'); res.write('data: 支付'); setTimeout(() => res.end('成功\n\n'), 15); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); port = (server.address() as any).port;
  child = spawn(process.execPath, [join(dir, 'host.cjs')], { env: { ...process.env, AE_CHAT_DATA_DIR: dir, AE_CHAT_KEY_test: 'test-native-secret' }, stdio: 'pipe' });
  const onMessage: ((m: any) => void)[] = [], onDisconnect: (() => void)[] = [], decoder = new FrameDecoder();
  child.stdout.on('data', data => { for (const message of decoder.push(data)) for (const listener of onMessage) listener(message); });
  child.on('close', () => onDisconnect.forEach(fn => fn()));
  vi.stubGlobal('chrome', { runtime: { connectNative: () => ({ postMessage: (message: any) => child.stdin.write(frame(message)), onMessage: { addListener: (fn: (m: any) => void) => onMessage.push(fn) }, onDisconnect: { addListener: (fn: () => void) => onDisconnect.push(fn) } }) } });
  bridge = new NativeBridge();
});
afterAll(async () => { child.stdin.end(); await new Promise<void>(r => child.once('close', () => r())); await new Promise<void>(r => server.close(() => r())); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
it('round-trips a real native-host process with framed RPC', async () => { expect((await bridge.request('ping')).version).toBe('0.1.0'); });
it('streams model bytes through the native host without exposing credentials', async () => {
  await bridge.request('config.set', { cliPath: 'ae-cli', binding: null, mcps: [], providers: [{ ...defaultProvider, id: 'test', credentialRef: 'test', baseURL: `http://127.0.0.1:${port}/v1` }] });
  const response = await bridge.fetch('test')(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: JSON.stringify({ input: 'hi', stream: true, previous_response_id: 'do-not-reuse' }) });
  expect(await response.text()).toBe('data: 支付成功\n\n'); expect(seen[0].authorization).toBe('Bearer test-native-secret'); expect(seen[0].body.store).toBe(false); expect(seen[0].body.previous_response_id).toBeUndefined();
  expect(JSON.stringify(await bridge.request('config.get'))).not.toContain('test-native-secret');
});
it('reassembles large Unicode JSON results below native frame limits', async () => {
  const name = '支付'.repeat(60000);
  const config: any = await bridge.request('config.get'); config.providers[0].name = name;
  const result = await bridge.request('config.set', config); expect(result.providers[0].name).toBe(name);
});
it('cancels an in-flight model response without restarting the request', async () => {
  const controller = new AbortController();
  const response = await bridge.fetch('test')(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', body: '{"input":"cancel","stream":true}', signal: controller.signal });
  const text = response.text(); controller.abort(); await expect(text).rejects.toThrow('已停止');
  expect(seen.filter(r => r.body.input === 'cancel')).toHaveLength(1);
});
