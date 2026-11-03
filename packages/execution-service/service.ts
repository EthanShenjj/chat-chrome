import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { HostConfigSchema, ScopeSchema, sameScope, safeURL, errorText, type ResourceChanged, type Operation, type Scope } from '../../packages/contracts/index';
import { cliArgs, toolSchemas, isWrite, reportSnapshot, changedPaths, CliError, type AeTool } from '../../packages/ae-cli-adapter/index';
import { atomicWrite, readConfig, writeConfig, readJSON, getDataDir, credential } from './storage';
import { assertAllowedOrigin, executionContext } from './context';
import { runCli, runProcess } from './cli-runner/index';
import { CliInstaller } from './installer/index';
import { McpManager } from './mcp-client/index';
import { CliAuthorization } from './cli-auth';
export class HostService {
  private get journalPath() { return join(getDataDir(), 'operations.json'); }
  mcp = new McpManager();
  installer = new CliInstaller();
  authorization = new CliAuthorization();
  private queue: Promise<unknown> = Promise.resolve();
  private approvals = new Map<string, string>();
  async dispatch(method: string, params: any = {}): Promise<unknown> {
    switch (method) {
      case 'ping': return { version: '0.1.0', platform: process.platform, node: process.version };
      case 'config.get': return readConfig();
      case 'config.set': {
        const config = HostConfigSchema.parse(params);
        if (config.aeOrigin) { const u = safeURL(config.aeOrigin); if (u.origin !== config.aeOrigin) throw new Error('AE 环境必须是 origin，不含路径'); assertAllowedOrigin(config.aeOrigin); if (config.binding && config.binding.origin !== config.aeOrigin) throw new Error('AE 页面与保存的环境地址不一致'); }
        if (config.binding) { const u = safeURL(config.binding.origin); if (u.origin !== config.binding.origin) throw new Error('AE 环境必须是 origin，不含路径'); }
        if (config.binding) assertAllowedOrigin(config.binding.origin);
        for (const p of config.providers) { safeURL(p.baseURL); assertAllowedOrigin(p.baseURL); }
        for (const m of config.mcps) {
          if (m.transport === 'http') { safeURL(m.url ?? ''); assertAllowedOrigin(m.url ?? ''); }
          else if (!m.command) throw new Error('stdio MCP 需要可执行文件');
          else if (executionContext() && !Object.hasOwn(executionContext()!.stdioCommands, m.command)) throw new Error('服务器仅允许管理员配置的 stdio MCP 别名');
        }
        if (new Set(config.providers.map(p => p.id)).size !== config.providers.length || new Set(config.mcps.map(m => m.id)).size !== config.mcps.length) throw new Error('连接 ID 不能重复');
        await writeConfig(config);
        await this.mcp.close(); return config;
      }
      case 'credential.set': { const p = z.object({ ref: z.string(), secret: z.string().min(1).max(16384) }).parse(params); await credential(p.ref, p.secret); return { saved: true }; }
      case 'cli.probe': { const c = await readConfig(); const r = await runProcess(c.cliPath, ['--version'], 15000); if (r.code !== 0) throw new Error(r.stderr); return { version: r.stdout.trim(), executable: c.cliPath }; }
      case 'cli.install.plan': return this.installer.plan(params.version);
      case 'cli.install.approve': return this.installer.approve(params.planId);
      case 'cli.install': return this.serial(() => this.installer.install(params.planId));
      case 'auth.login.start': return this.authorization.start();
      case 'auth.login.check': return this.authorization.check();
      case 'auth.login.cancel': return this.authorization.cancel();
      case 'auth.cli.status': return this.authorization.status();
      case 'auth.status': { const c = await readConfig(); if (!c.binding) throw new Error('请先绑定 AE 环境与项目'); return runCli(c.cliPath, ['--host', c.binding.origin, '--format', 'json', '--no-update-check', 'auth', 'status']); }
      case 'auth.login': { if (executionContext()) throw new Error('线上服务请使用 AE Token 授权'); const c = await readConfig(); if (!c.binding) throw new Error('请先绑定 AE 环境'); const r = await runProcess(c.cliPath, ['--host', c.binding.origin, 'auth', 'login'], 300000); return { code: r.code, output: r.stdout, error: r.stderr }; }
      case 'ae.execute': return this.serial(() => this.executeAe(params));
      case 'operations.list': return this.operations();
      case 'mcp.list': { const c = await this.mcpConfig(params.serverId); return this.mcp.list(c); }
      case 'mcp.disconnect': await this.mcp.disconnect(params.serverId); return { disconnected: true };
      case 'mcp.approve': { const token = randomUUID(); this.approvals.set(token, JSON.stringify({ serverId: params.serverId, name: params.name, args: params.args })); return { token }; }
      case 'mcp.call': {
        const key = JSON.stringify({ serverId: params.serverId, name: params.name, args: params.args });
        if (this.approvals.get(params.approvalToken) !== key) throw new Error('MCP 调用需要用户确认');
        this.approvals.delete(params.approvalToken);
        return this.mcp.call(await this.mcpConfig(params.serverId), params.name, params.args);
      }
      default: throw new Error('未知或未授权的执行器方法');
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const job = this.queue.then(fn, fn); this.queue = job.catch(() => {}); return job; }
  private async mcpConfig(id: string) { const c = (await readConfig()).mcps.find(c => c.id === id); if (!c) throw new Error('MCP 未配置'); return c; }
  async operations(): Promise<Operation[]> { return readJSON<Operation[]>(this.journalPath, []); }
  private async executeAe(params: any) {
    const { tool, operationId, taskId } = z.object({ tool: z.enum(Object.keys(toolSchemas) as [AeTool, ...AeTool[]]), operationId: z.uuid(), taskId: z.string() }).parse(params);
    const args = toolSchemas[tool].parse(params.args) as Record<string, unknown>;
    const scope: Scope = ScopeSchema.parse(params.scope), config = await readConfig();
    if (!config.binding || !sameScope(config.binding, scope)) throw new Error('任务上下文与执行器绑定不一致；请重新绑定后开始新任务');
    assertAllowedOrigin(scope.origin);
    const records = await this.operations();
    const previous = records.find(r => r.id === operationId);
    if (previous) { if (previous.state === 'completed') return { result: previous.result, event: previous.event }; throw new CliError('此操作已派发，结果需要核实；不会重复执行', true); }
    const auth = await runCli(config.cliPath, ['--host', scope.origin, '--format', 'json', '--no-update-check', 'auth', 'status']) as any;
    if (!auth.authenticated) throw new Error('AE CLI 尚未登录，请在设置中登录');
    let before: ReturnType<typeof reportSnapshot> | undefined;
    if (tool === 'ae.report.update') {
      before = reportSnapshot(await runCli(config.cliPath, cliArgs('ae.report.get', { reportId: args.reportId }, scope)));
      if (before.version !== args.version) throw new Error(`版本冲突：期望 ${args.version}，当前 ${before.version}。请重新读取并展示差异`);
    }
    const record: Operation = { id: operationId, taskId, tool, scope, args, state: 'running', startedAt: Date.now() };
    records.push(record); await atomicWrite(this.journalPath, records);
    let saved = false;
    try {
      let result: any;
      if (tool === 'ae.report.schema') { const r = await runProcess(config.cliPath, cliArgs(tool, args, scope)); if (r.code !== 0) throw new Error(r.stderr); result = { help: r.stdout }; }
      else result = await runCli(config.cliPath, cliArgs(tool, args, scope));
      saved = isWrite(tool);
      record.result = result;
      if (isWrite(tool)) {
        if (result?.task_id || result?.taskId || ['pending', 'running', 'accepted', 'queued'].includes(result?.status)) throw new CliError('服务端返回异步任务，尚未确认终态；请核实后再继续', true);
        const reportId = args.reportId ?? result?.report_id ?? result?.reportId ?? result?.id ?? result?.report?.report_id;
        if (!reportId) throw new CliError('保存已被受理，未返回资源 ID；请先核实，勿重复创建', true);
        const after = reportSnapshot(await runCli(config.cliPath, cliArgs('ae.report.get', { reportId: Number(reportId) }, scope)));
        if (after.id !== String(reportId)) throw new CliError('保存后读取到的资源 ID 不匹配；请核实结果', true);
        if (before && after.version <= before.version) throw new CliError('保存后尚未读到新版本；结果待核实', true);
        if ((args.name !== undefined && args.name !== after.name) || (args.description !== undefined && args.description !== after.description) || (args.definition !== undefined && changedPaths(args.definition, after.definition).length)) throw new CliError('保存后读到的定义与请求不一致；可能存在并发修改或服务端归一化，请先核实', true);
        const event: ResourceChanged = { eventId: randomUUID(), operationId, sequence: records.filter(r => r.event).length + 1, createdAt: Date.now(), scope,
          resource: { type: 'report', id: after.id }, action: tool === 'ae.report.create' ? 'created' : 'updated',
          changedPaths: before ? changedPaths(before, after) : ['/'], beforeVersion: before ? String(before.version) : undefined, afterVersion: String(after.version),
          afterDefinitionHash: createHash('sha256').update(JSON.stringify(after.definition)).digest('hex'),
          affectedResources: ((args.dashboardIds ?? []) as number[]).map(id => ({ type: 'dashboard', id: String(id) })) };
        record.event = event;
        try { result = { ...result, link: await runCli(config.cliPath, cliArgs('ae.asset.getUrl', { reportId: Number(after.id) }, scope)) }; } catch { /* A link lookup cannot invalidate a confirmed save. */ }
      }
      record.result = result; record.state = 'completed'; await atomicWrite(this.journalPath, records); return { result, event: record.event };
    } catch (e) {
      record.state = saved || (e instanceof CliError && e.unknownResult) ? 'unknown' : 'failed'; record.error = errorText(e);
      await atomicWrite(this.journalPath, records); throw new CliError(`${record.state === 'unknown' ? '结果待核实：' : ''}${record.error}`, record.state === 'unknown');
    }
  }
}
