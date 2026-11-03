import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpManager } from '../packages/execution-service/mcp-client/index';
import type { McpConfig } from '../packages/contracts/index';
it('discovers/calls stdio MCP and enforces tool allowlists and JSON Schema', async () => {
  const manager = new McpManager();
  const config: McpConfig = { id: 'test-local', name: 'test', transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs')], enabled: true, allowedTools: ['add'] };
  try { expect((await manager.list(config))[0].name).toBe('add'); const result: any = await manager.call(config, 'add', { a: 2, b: 3 }); expect(result.content[0].text).toBe('5'); await expect(manager.call(config, 'add', { a: 'bad', b: 3 })).rejects.toThrow('Schema'); await expect(manager.call({ ...config, allowedTools: [] }, 'add', { a: 2, b: 3 })).rejects.toThrow('授权'); } finally { await manager.close(); }
});
it('discovers/calls Streamable HTTP MCP', async () => {
  const transports: StreamableHTTPServerTransport[] = [];
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'http-test', version: '1.0' }); mcp.registerTool('echo', { inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); transports.push(transport); await mcp.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as any).port;
  const manager = new McpManager(), config: McpConfig = { id: 'http', name: 'http', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, enabled: true, args: [], allowedTools: ['echo'] };
  try { expect((await manager.list(config))[0].name).toBe('echo'); const result: any = await manager.call(config, 'echo', { message: 'hello' }); expect(result.content[0].text).toBe('hello'); } finally { await manager.close(); for (const transport of transports) await transport.close(); await new Promise<void>(r => server.close(() => r())); }
});
