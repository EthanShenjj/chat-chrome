import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent } from '../../../packages/agent-runtime/index';
import { HostConfigSchema, ScopeSchema, defaultConfig, errorText, sameScope, type Snapshot, type Session, type PageContext, type ProviderConfig, type Operation } from '../../../packages/contracts/index';
import { isWrite, type AeTool } from '../../../packages/ae-cli-adapter/index';
import { HostService } from '../../../packages/execution-service/service';
import { atomicWrite, credential, readConfig, readJSON } from '../../../packages/execution-service/storage';
import { withExecutionContext, type ExecutionContext } from '../../../packages/execution-service/context';
import { aeCredentialRef } from '../../../packages/execution-service/cli-runner/index';
import { modelRequest } from '../../../packages/execution-service/model-transport/index';

const freshSession = (): Session => ({ id: randomUUID(), title: '新的对话', messages: [], history: [], status: 'idle', updatedAt: Date.now() });
interface WorkspaceData { sessionId: string; sessions: Session[]; providerId: string; }
export class CloudWorkspace {
  readonly host = new HostService();
  private data: WorkspaceData = { sessionId: '', sessions: [], providerId: '' };
  private approvals: Snapshot['approvals'] = [];
  private approvalResolvers = new Map<string, (approved: boolean) => void>();
  private active?: AbortController;
  private page?: PageContext;
  private persistence: Promise<unknown> = Promise.resolve();
  private commands: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  revision = 0;
  constructor(readonly context: ExecutionContext) { this.ready = this.run(() => this.initialize()); }
  run<T>(fn: () => T) { return withExecutionContext(this.context, fn); }
  get session() { return this.data.sessions.find(s => s.id === this.data.sessionId)!; }
  private get path() { return join(this.context.dataDir, 'workspace.json'); }
  private async initialize() {
    await mkdir(join(this.context.dataDir, 'tmp'), { recursive: true, mode: 0o700 });
    this.data = await readJSON(this.path, this.data);
    if (!this.data.sessions.length || !this.data.sessions.some(s => s.id === this.data.sessionId)) { const s = freshSession(); this.data.sessions.push(s); this.data.sessionId = s.id; }
    for (const s of this.data.sessions) if (s.status === 'running') { s.status = 'interrupted'; s.error = '服务已重启。任务未自动重试，请核实操作记录后继续'; }
    await this.persist();
  }
  private async persist() {
    this.session.updatedAt = Date.now(); this.revision++;
    const data = structuredClone(this.data);
    const next = this.persistence.then(() => atomicWrite(this.path, data)); this.persistence = next.catch(() => {}); await next;
  }
  async snapshot(): Promise<Snapshot> {
    await this.ready;
    return this.run(async () => ({ config: await readConfig(), connected: true, session: structuredClone(this.session), operations: (await this.host.operations()).map(o => o.state === 'running' && !this.active ? { ...o, state: 'unknown' as const } : o), deliveries: [], approvals: structuredClone(this.approvals), providerId: this.data.providerId, page: this.page }));
  }
  dispatch(message: any): Promise<any> {
    // Serialize control commands; model execution runs separately and is controlled by active.
    const next = this.commands.then(() => this.run(async () => { await this.ready; return this.handle(message); })); this.commands = next.catch(() => {}); return next;
  }
  private ensureIdle() { if (this.active) throw new Error('请等待或停止当前任务后再修改设置'); }
  private async handle(message: any): Promise<any> {
    switch (message.type) {
      case 'state.get': return this.snapshot();
      case 'chat.send': {
        this.ensureIdle(); const text = z.string().trim().min(1).max(32000).parse(message.text);
        const config = await readConfig(), provider = config.providers.find(p => p.id === this.data.providerId);
        if (!provider) throw new Error('请先配置模型并测试连接');
        if (this.session.scope && (!config.binding || !sameScope(this.session.scope, config.binding))) throw new Error('此会话属于其他工作区，请新建对话');
        this.page = this.validatePage(message.page, config.binding);
        const signal = new AbortController(); this.active = signal;
        const session = this.session; session.scope = config.binding ?? undefined; session.status = 'running'; session.error = undefined;
        if (!session.messages.length) session.title = text.slice(0, 30);
        session.messages.push({ id: randomUUID(), role: 'user', text, createdAt: Date.now() });
        const answer = { id: randomUUID(), role: 'assistant' as const, text: '', createdAt: Date.now() }; session.messages.push(answer);
        try { await this.persist(); } catch (e) { this.active = undefined; session.status = 'failed'; throw e; }
        void this.run(() => this.executeTask(provider, text, session, answer, signal)).catch(() => {});
        return { started: true };
      }
      case 'chat.stop': this.active?.abort(); return { stopped: true };
      case 'chat.new': { this.ensureIdle(); const s = freshSession(); this.data.sessions.push(s); this.data.sessionId = s.id; this.page = undefined; await this.persist(); return this.snapshot(); }
      case 'sessions.list': return this.data.sessions.filter(s => s.messages.length).map(s => ({ id: s.id, title: s.title, messages: s.messages.map(m => ({ ...m, text: '' })), status: s.status, updatedAt: s.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
      case 'sessions.load': { this.ensureIdle(); if (!this.data.sessions.some(s => s.id === message.id)) throw new Error('会话不存在'); this.data.sessionId = message.id; this.page = undefined; await this.persist(); return this.snapshot(); }
      case 'provider.select': { this.ensureIdle(); const config = await readConfig(); if (!config.providers.some(p => p.id === message.id)) throw new Error('模型不存在'); this.data.providerId = message.id; await this.persist(); return this.snapshot(); }
      case 'config.save': {
        this.ensureIdle(); const current = await readConfig(), config = HostConfigSchema.parse(message.config);
        // Remote users cannot choose a server executable or bypass capability testing.
        config.cliPath = current.cliPath;
        config.providers = config.providers.map(p => { const old = current.providers.find(o => o.id === p.id); return { ...p, capabilities: { ...p.capabilities, toolCalling: Boolean(old?.capabilities.toolCalling && old.baseURL === p.baseURL && old.model === p.model && old.protocol === p.protocol && old.credentialRef === p.credentialRef) } }; });
        await this.host.dispatch('config.set', config);
        if (current.binding && (!config.binding || !sameScope(current.binding, config.binding))) { const s = freshSession(); this.data.sessions.push(s); this.data.sessionId = s.id; this.page = undefined; }
        if (!config.providers.some(p => p.id === this.data.providerId)) this.data.providerId = config.providers[0]?.id ?? '';
        await this.persist(); return this.snapshot();
      }
      case 'credential.save': { this.ensureIdle(); const { ref, secret } = z.object({ ref: z.string().max(128), secret: z.string().min(1).max(16384) }).parse(message); await credential(ref, secret); return { saved: true }; }
      case 'auth.save': { this.ensureIdle(); const config = await readConfig(); if (!config.binding) throw new Error('请先绑定 AE 环境'); const token = z.string().min(1).max(16384).parse(message.token); await credential(aeCredentialRef(config.binding.origin), token); return { saved: true, message: 'AE Token 已在服务器加密保存' }; }
      case 'auth.status': return this.host.dispatch('auth.status');
      case 'cli.probe': return this.host.dispatch('cli.probe');
      case 'mcp.list': return this.host.dispatch('mcp.list', { serverId: message.serverId });
      case 'mcp.disconnect': return this.host.dispatch('mcp.disconnect', { serverId: message.serverId });
      case 'approval.resolve': this.approvalResolvers.get(message.id)?.(message.approved === true); return { resolved: true };
      case 'provider.test': { this.ensureIdle(); return this.testProvider(message.id, message.tools === true); }
      case 'operations.reconcile': {
        this.ensureIdle(); const records = await this.host.operations(), record = records.find(o => o.id === message.id);
        if (!record || !['unknown', 'running'].includes(record.state)) throw new Error('记录不处于待核实状态');
        record.state = 'failed'; record.error = '用户已手动核实并解除写入阻塞；原结果未自动确认'; await atomicWrite(join(this.context.dataDir, 'operations.json'), records); this.revision++; return this.snapshot();
      }
      default: throw new Error('未知或未授权的服务操作');
    }
  }
  private validatePage(value: unknown, binding: Snapshot['config']['binding']): PageContext | undefined {
    if (!value || !binding) return;
    const p = z.object({ scope: ScopeSchema, resource: z.object({ type: z.enum(['report', 'dashboard', 'report-list']), id: z.string().max(100) }).optional(), title: z.string().max(500), url: z.url().max(4000), dirty: z.union([z.boolean(), z.literal('unknown')]), adapter: z.string().max(100) }).parse(value);
    if (!sameScope(p.scope, binding) || new URL(p.url).origin !== binding.origin) throw new Error('页面上下文与绑定不一致'); return p;
  }
  private async approve(taskId: string, label: string, details: unknown, signal: AbortSignal) {
    if (signal.aborted) return false;
    const id = randomUUID(); this.approvals.push({ id, taskId, label, details }); this.revision++;
    return new Promise<boolean>(resolve => {
      const finish = (approved: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.approvalResolvers.delete(id); this.approvals = this.approvals.filter(a => a.id !== id); this.revision++; resolve(approved); };
      const abort = () => finish(false); const timer = setTimeout(abort, 600000);
      this.approvalResolvers.set(id, finish); signal.addEventListener('abort', abort, { once: true });
    });
  }
  private async executeTask(provider: ProviderConfig, text: string, session: Session, answer: Session['messages'][number], controller: AbortController) {
    const taskId = `${session.id}:${randomUUID()}`, scope = session.scope ? structuredClone(session.scope) : undefined, signal = controller.signal;
    try {
      const mcpTools = [];
      if (provider.capabilities.toolCalling) {
        mcpTools.push({ name: 'ae_cli_status', description: '检测服务器上的 AE CLI，不读取用户电脑。', schema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => { try { return await this.host.dispatch('cli.probe'); } catch (e) { return { installed: false, message: errorText(e) }; } } });
        mcpTools.push({ name: 'ae_cli_install', description: '在服务器的当前用户工作区安装 AE CLI；展示来源版本并请求用户确认。version 可省略。', schema: { type: 'object', properties: { version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?$' } }, additionalProperties: false }, execute: async (args: Record<string, unknown>) => {
          const plan: any = await this.host.dispatch('cli.install.plan', args);
          if (!(await this.approve(taskId, `在服务器安装 AE CLI ${plan.version}`, plan, signal))) return { installed: false, message: '安装已取消' };
          await this.host.dispatch('cli.install.approve', { planId: plan.planId }); const result = await this.host.dispatch('cli.install', { planId: plan.planId }); this.revision++; return result;
        } });
        const config = await readConfig();
        for (const server of config.mcps.filter(m => m.enabled)) {
          let listed: any[];
          try { listed = await this.host.dispatch('mcp.list', { serverId: server.id }) as any[]; }
          catch { continue; }
          for (const [index, t] of listed.entries()) if (server.allowedTools.includes(t.name)) mcpTools.push({ name: `mcp_${server.id}_${index}`, description: `${server.name}/${t.name}: ${String(t.description ?? '').slice(0, 2000)}`, schema: t.inputSchema, execute: async (args: Record<string, unknown>) => {
            if (!(await this.approve(taskId, `调用 ${server.name} · ${t.name}`, args, signal))) throw new Error('用户拒绝调用');
            const approval: any = await this.host.dispatch('mcp.approve', { serverId: server.id, name: t.name, args });
            return this.host.dispatch('mcp.call', { serverId: server.id, name: t.name, args, approvalToken: approval.token });
          } });
        }
      }
      let lastSave = 0;
      const result = await runAgent({ provider, scope, page: this.page, text, history: session.history, signal, mcpTools,
        fetch: async (input, init) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; return modelRequest(provider, url.endsWith('/responses') ? '/responses' : '/chat/completions', JSON.parse(String(init?.body || '{}')), init?.signal ?? signal); },
        execute: async (tool: AeTool, args) => {
          if (signal.aborted) throw new Error('任务已停止'); if (!scope) throw new Error('请先绑定 AE 工作区');
          const records = await this.host.operations(); if (isWrite(tool) && records.some(o => sameScope(o.scope, scope) && isWrite(o.tool) && ['unknown', 'running'].includes(o.state))) throw new Error('存在待核实的写操作，请先检查记录');
          const result = await this.host.dispatch('ae.execute', { tool, args, scope, taskId, operationId: randomUUID() }); this.revision++;
          return { ...result as any, pageSync: '保存结果已记录，等待扩展处理相关页面；此结果不代表页面已同步' };
        },
        onText: async text => { answer.text = text; this.revision++; if (Date.now() - lastSave > 200) { lastSave = Date.now(); await this.persist(); } }
      });
      answer.text = result.output; session.history = result.history; session.status = 'idle';
    } catch (e) { session.status = signal.aborted ? 'interrupted' : 'failed'; session.error = signal.aborted ? '已停止模型。已提交的保存请以操作记录为准' : errorText(e); }
    finally { this.active = undefined; await this.persist(); }
  }
  private async testProvider(id: string, tools: boolean) {
    const config = await readConfig(), provider = config.providers.find(p => p.id === id); if (!provider) throw new Error('请先保存模型');
    const fn = { name: 'connection_check', description: 'Connection test only.', parameters: { type: 'object', properties: { token: { type: 'string', enum: ['ae-ok'] } }, required: ['token'], additionalProperties: false } };
    const prompt = tools ? 'Call connection_check with token ae-ok.' : 'Reply OK.';
    const body = provider.protocol === 'openai-responses'
      ? { input: prompt, stream: false, ...(tools ? { tools: [{ type: 'function', ...fn, strict: true }], tool_choice: { type: 'function', name: fn.name } } : {}) }
      : { messages: [{ role: 'user', content: prompt }], stream: false, ...(tools ? { tools: [{ type: 'function', function: fn }], tool_choice: { type: 'function', function: { name: fn.name } } } : {}) };
    const response = await modelRequest(provider, provider.protocol === 'openai-responses' ? '/responses' : '/chat/completions', body, AbortSignal.timeout(30000));
    const result = await response.json() as any; if (!response.ok || result.error) throw new Error(result.error?.message || `HTTP ${response.status}`);
    if (tools) {
      const call = provider.protocol === 'openai-responses' ? result.output?.find((o: any) => o.type === 'function_call') : result.choices?.[0]?.message?.tool_calls?.[0]?.function;
      if (call?.name !== fn.name || JSON.parse(call.arguments).token !== 'ae-ok') throw new Error('工具调用测试未通过');
      provider.capabilities.toolCalling = true; await this.host.dispatch('config.set', config); this.revision++;
    }
    return { ok: true, toolCalling: tools };
  }
}

const globalWorkspaces = globalThis as typeof globalThis & { aeWorkspaces?: Map<string, CloudWorkspace> };
const workspaces = globalWorkspaces.aeWorkspaces ??= new Map<string, CloudWorkspace>();
export async function getWorkspace(context: ExecutionContext) { const key = `${context.dataDir}:${context.userId}`; let workspace = workspaces.get(key); if (!workspace) { workspace = new CloudWorkspace(context); workspaces.set(key, workspace); } await workspace.ready; return workspace; }
