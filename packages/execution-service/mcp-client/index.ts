import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
import { type McpConfig, safeURL } from '../../../packages/contracts/index';
import { credential } from '../storage';
import { executionContext, assertAllowedOrigin, childEnvironment } from '../context';
export class McpManager {
  private clients = new Map<string, { client: Client; config: string }>();
  async connect(config: McpConfig) {
    if (!config.enabled) throw new Error('MCP 已停用');
    const existing = this.clients.get(config.id);
    if (existing?.config === JSON.stringify(config)) return existing.client;
    if (existing) await this.disconnect(config.id);
    const client = new Client({ name: 'ae-chat-agent', version: '0.1.0' });
    const token = config.credentialRef ? await credential(config.credentialRef) : undefined;
    const context = executionContext();
    if (config.transport === 'http') assertAllowedOrigin(config.url ?? '');
    const stdio = context ? (Object.hasOwn(context.stdioCommands, config.command ?? '') ? context.stdioCommands[config.command ?? ''] : undefined) : { command: config.command || '', args: config.args };
    if (config.transport === 'stdio' && !stdio) throw new Error('MCP 程序未由管理员授权');
    const transport = config.transport === 'http'
      ? new StreamableHTTPClientTransport(safeURL(config.url ?? ''), { requestInit: { redirect: 'error', headers: token ? { Authorization: `Bearer ${token}` } : {} } })
      : new StdioClientTransport({ command: stdio!.command, args: stdio!.args, stderr: 'pipe', cwd: context?.dataDir, env: { ...Object.fromEntries(Object.entries(childEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ...(token ? { MCP_TOKEN: token } : {}) } });
    await client.connect(transport, { timeout: 20000 });
    client.onclose = () => this.clients.delete(config.id);
    this.clients.set(config.id, { client, config: JSON.stringify(config) });
    return client;
  }
  async list(config: McpConfig) { const client = await this.connect(config); const tools = []; let cursor: string | undefined; do { const result = await client.listTools({ cursor }); tools.push(...result.tools); cursor = result.nextCursor; if (tools.length > 500) throw new Error('MCP 工具数量超过 500'); } while (cursor); return tools; }
  async call(config: McpConfig, name: string, args: Record<string, unknown>) {
    if (!config.allowedTools.includes(name)) throw new Error('该 MCP 工具尚未授权');
    const tools = await this.list(config), tool = tools.find(t => t.name === name);
    if (!tool) throw new Error('MCP 工具不存在');
    const validate = new Ajv({ strict: false, allErrors: true }).compile(tool.inputSchema);
    if (!validate(args)) throw new Error(`MCP 参数不符合 Schema：${JSON.stringify(validate.errors)}`);
    const result = await (await this.connect(config)).callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    if (result.isError) throw new Error(`MCP 执行失败：${JSON.stringify(result.content)}`);
    return result;
  }
  async disconnect(id: string) { const entry = this.clients.get(id); this.clients.delete(id); await entry?.client.close(); }
  async close() { await Promise.all([...this.clients.keys()].map(id => this.disconnect(id))); }
}
