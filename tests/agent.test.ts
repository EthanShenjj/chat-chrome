import { it, expect } from 'vitest';
import { runAgent, portableHistory } from '../packages/agent-runtime/index';
import { defaultProvider } from '../packages/contracts/index';
const scope = { origin: 'https://ae.example.com', projectId: '7', actorId: 'alice' };
it('runs a streamed third-party Chat Completions tool loop through custom transport', async () => {
  let calls = 0; const executions: unknown[] = [], texts: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string); expect(body.model).toBe('compatible-model');
    calls++;
    const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'compatible-model', choices: [{ index: 0, delta, finish_reason: finish }] });
    const events = calls === 1 ? [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ae_report_get', arguments: '{"reportId":42}' } }] }), chunk({}, 'tool_calls')] : [chunk({ role: 'assistant', content: '已读取' }), chunk({ content: '报表。' }), chunk({}, 'stop')];
    if (calls === 2) expect(body.messages.some((m: any) => m.role === 'tool')).toBe(true);
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const result = await runAgent({ provider: { ...defaultProvider, protocol: 'openai-chat-completions', model: 'compatible-model', capabilities: { ...defaultProvider.capabilities, toolCalling: true } }, scope, history: [], text: '读取报表 42', signal: new AbortController().signal, fetch: transport, mcpTools: [], execute: async (name, args) => { executions.push({ name, args }); return { report_id: 42, version: 3, definition: {} }; }, onText: async t => { texts.push(t); } });
  expect(calls).toBe(2); expect(executions).toEqual([{ name: 'ae.report.get', args: { reportId: 42 } }]); expect(result.output).toBe('已读取报表。'); expect(texts.at(-1)).toBe('已读取报表。'); expect(result.history.length).toBeGreaterThan(2);
});
it('does not expose tools to a provider that has not passed tool testing', async () => {
  const transport: typeof fetch = async (_url, init) => { const body = JSON.parse(init!.body as string); expect(body.tools ?? []).toHaveLength(0); return Response.json({ id: 'chat-test', object: 'chat.completion', created: 1, model: 'chat-only', choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); };
  const result = await runAgent({ provider: { ...defaultProvider, protocol: 'openai-chat-completions', model: 'chat-only', capabilities: { ...defaultProvider.capabilities, streaming: false, toolCalling: false } }, history: [], text: '你好', signal: new AbortController().signal, fetch: transport, mcpTools: [], execute: async () => { throw new Error('must not execute'); }, onText: async () => {} }); expect(result.output).toBe('你好');
});
it('runs an OpenAI Responses tool loop using locally reconstructed history', async () => {
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string); calls++; expect(body.previous_response_id).toBeUndefined();
    return Response.json({ id: `resp_${calls}`, object: 'response', created_at: 1, status: 'completed', model: 'test-responses', output: calls === 1 ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_resp', name: 'ae_report_get', arguments: '{"reportId":42}', status: 'completed' }] : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Responses 已读取。', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  };
  const executed: string[] = [];
  const result = await runAgent({ provider: { ...defaultProvider, model: 'test-responses', capabilities: { ...defaultProvider.capabilities, streaming: false, toolCalling: true } }, scope, history: [], text: '读取 42', signal: new AbortController().signal, fetch: transport, mcpTools: [], execute: async name => { executed.push(name); return { version: 3 }; }, onText: async () => {} });
  expect(result.output).toBe('Responses 已读取。'); expect(executed).toEqual(['ae.report.get']); expect(calls).toBe(2);
  expect(portableHistory([{ type: 'function_call', id: 'vendor-id', callId: 'keep', name: 'x', arguments: '{}', providerData: { vendor: true } }, { type: 'reasoning', id: 'private' }])).toEqual([{ type: 'function_call', callId: 'keep', name: 'x', arguments: '{}' }]);
});
