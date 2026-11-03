import { afterEach, expect, test, vi } from 'vitest';
import { defaultProvider } from '../packages/contracts/index';
import { modelRequest } from '../packages/execution-service/model-transport/index';
import { withExecutionContext } from '../packages/execution-service/context';
import { credential } from '../packages/execution-service/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, portableHistory } from '../packages/agent-runtime/index';
afterEach(() => vi.restoreAllMocks());
test.each(['https://api.deepseek.com', 'https://api.moonshot.cn', 'https://api.moonshot.ai'])('preserves vendor reasoning across tool calls at %s', async origin => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ae-provider-'));
  try {
    await withExecutionContext({ userId: 'test', dataDir, encryptionKey: 'x'.repeat(32), allowedOrigins: [origin], stdioCommands: {} }, async () => {
      await credential('test', 'fixture-only-key');
      const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [{ message: { role: 'assistant', content: 'OK', reasoning_content: 'vendor-reasoning' } }] }));
      const response = await modelRequest({ ...defaultProvider, protocol: 'openai-chat-completions', baseURL: `${origin}/v1`, model: origin.includes('deepseek') ? 'deepseek-flash' : 'kimi-k3.1-pro', credentialRef: 'test' }, '/chat/completions', { messages: [{ role: 'assistant', content: null, reasoning: 'prior-thinking', tool_calls: [] }] }, new AbortController().signal);
      const payload = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      expect(payload.messages[0].reasoning_content).toBe('prior-thinking');
      expect(payload.messages[0].reasoning).toBeUndefined();
      expect(payload.thinking).toBeUndefined();
      expect((await response.json()).choices[0].message.reasoning).toBe('vendor-reasoning');
    });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test('carries streamed vendor reasoning through a tool loop and the next user turn', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ae-reasoning-'));
  try {
    await withExecutionContext({ userId: 'test', dataDir, encryptionKey: 'x'.repeat(32), allowedOrigins: ['https://api.moonshot.cn'], stdioCommands: {} }, async () => {
      await credential('test', 'fixture-only-key');
      const provider = { ...defaultProvider, id: 'kimi', protocol: 'openai-chat-completions' as const, baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro', credentialRef: 'test', capabilities: { ...defaultProvider.capabilities, toolCalling: true } };
      let calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(init!.body as string); calls++;
        if (calls > 1) expect(body.messages.find((m: any) => m.tool_calls?.length)?.reasoning_content).toBe('先检查工具');
        if (calls === 3) expect(body.messages.some((m: any) => m.reasoning_content === '工具已返回')).toBe(true);
        const delta = calls === 1 ? { reasoning_content: '先检查工具', tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name: 'cli_status', arguments: '{}' } }] } : { reasoning_content: '工具已返回', content: '完成' };
        const wire = `data: ${JSON.stringify({ id: `chat-${calls}`, object: 'chat.completion.chunk', created: 1, model: provider.model, choices: [{ index: 0, delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`;
        const bytes = new TextEncoder().encode(wire);
        return new Response(new ReadableStream({ start(c) { for (let n = 0; n < bytes.length; n += 7) c.enqueue(bytes.slice(n, n + 7)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      });
      const options = { provider, history: [], text: '检查 CLI', signal: new AbortController().signal, fetch: (async (_url: any, init: any) => modelRequest(provider, '/chat/completions', JSON.parse(init.body), init.signal)) as typeof fetch, execute: async () => ({}), mcpTools: [{ name: 'cli_status', description: 'read-only status', schema: { type: 'object', properties: {} }, execute: async () => ({ installed: false }) }], onText: async () => {} };
      const first = await runAgent(options); expect(first.output).toBe('完成');
      expect(portableHistory(first.history, 'other-provider').some(i => i.type === 'reasoning')).toBe(false);
      await runAgent({ ...options, history: first.history, text: '继续' });
      expect(calls).toBe(3);
    });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
