import { FrameDecoder, frame } from './protocol';
import { HostService } from '../../packages/execution-service/service';
import { readConfig } from '../../packages/execution-service/storage';
import { modelRequest } from '../../packages/execution-service/model-transport/index';
import { errorText } from '../../packages/contracts/index';
const service = new HostService(), decoder = new FrameDecoder(), controllers = new Map<string, AbortController>();
const send = (message: unknown) => process.stdout.write(frame(message));
const result = (id: string, value: unknown) => {
  const json = JSON.stringify(value ?? null);
  // Each fragment is well below Chrome's 1 MB native-to-browser limit, including Unicode escaping.
  if (Buffer.byteLength(json) < 128000) { send({ id, type: 'result', result: value ?? null }); return; }
  for (let i = 0; i < json.length; i += 16000) send({ id, type: 'json-chunk', chunk: json.slice(i, i + 16000) });
  send({ id, type: 'json-end' });
};
async function dispatch(message: any) {
  const { id, method, params } = message;
  if (typeof id !== 'string' || typeof method !== 'string') return;
  if (method === 'cancel') { controllers.get(params?.id)?.abort(); return; }
  try {
    if (method === 'model.request') {
      const provider = (await readConfig()).providers.find(p => p.id === params.providerId); if (!provider) throw new Error('模型未配置');
      const controller = new AbortController(); controllers.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 180000);
      try {
        const response = await modelRequest(provider, params.path, params.body, controller.signal); send({ id, type: 'headers', status: response.status });
        if (!response.body) throw new Error('模型响应为空');
        const reader = response.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; for (let i = 0; i < value.length; i += 24000) send({ id, type: 'chunk', chunk: Buffer.from(value.subarray(i, i + 24000)).toString('base64') }); }
        send({ id, type: 'end' });
      } finally { clearTimeout(timeout); controllers.delete(id); }
    } else result(id, await service.dispatch(method, params));
  } catch (e) { send({ id, type: 'error', error: errorText(e), unknownResult: Boolean((e as any)?.unknownResult) }); }
}
process.stdin.on('data', chunk => { try { for (const message of decoder.push(chunk)) void dispatch(message); } catch (e) { process.stderr.write(errorText(e)); process.exit(1); } });
process.stdin.on('end', () => { for (const c of controllers.values()) c.abort(); void service.mcp.close().finally(() => process.exit(0)); });
process.on('uncaughtException', e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
