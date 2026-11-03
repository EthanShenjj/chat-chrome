import { z } from 'zod';
import { type Scope } from '../contracts/index';
const id = z.number().int().positive();
const model = z.enum(['event', 'retention', 'funnel', 'distribution', 'attribution', 'interval', 'path', 'prop_analysis', 'sql', 'heat_map', 'rank_list', 'revenue', 'tag']);
export const toolSchemas = {
  'ae.report.get': z.object({ reportId: id }).strict(),
  'ae.report.create': z.object({ name: z.string().min(1).max(256), description: z.string().optional(), modelType: model, definition: z.record(z.string(), z.unknown()), dashboardIds: z.array(id).optional() }).strict(),
  'ae.report.update': z.object({ reportId: id, version: z.number().int().nonnegative(), name: z.string().min(1).optional(), description: z.string().optional(), modelType: model.optional(), definition: z.record(z.string(), z.unknown()).optional() }).strict().refine(a => a.name !== undefined || a.description !== undefined || a.definition !== undefined, '至少提供一项修改').refine(a => !a.definition || a.modelType, '修改定义必须提供 modelType'),
  'ae.report.query': z.object({ reportId: id }).strict(),
  'ae.asset.getUrl': z.object({ reportId: id }).strict(),
  'ae.metadata.events': z.object({ query: z.string().optional() }).strict(),
  'ae.report.schema': z.object({}).strict()
};
export type AeTool = keyof typeof toolSchemas;
export function isWrite(tool: string) { return tool === 'ae.report.create' || tool === 'ae.report.update'; }
export function cliArgs(tool: AeTool, raw: unknown, scope: Scope): string[] {
  const a = toolSchemas[tool].parse(raw) as Record<string, unknown>;
  const common = ['--host', scope.origin, '--format', 'json', '--no-update-check'];
  const args: string[] = [];
  const flag = (name: string, value: unknown) => { if (value !== undefined) args.push(`--${name}`, typeof value === 'object' ? JSON.stringify(value) : String(value)); };
  switch (tool) {
    case 'ae.report.get': args.push('analysis', 'report', 'get'); flag('report-id', a.reportId); break;
    case 'ae.report.create': args.push('analysis', 'report', 'create'); flag('report-name', a.name); flag('report-desc', a.description); flag('model-type', a.modelType); flag('definition', a.definition); flag('dashboard-ids', a.dashboardIds); break;
    case 'ae.report.update': args.push('analysis', 'report', 'update'); flag('report-id', a.reportId); flag('report-version', a.version); flag('report-name', a.name); flag('report-desc', a.description); flag('model-type', a.modelType); flag('definition', a.definition); break;
    case 'ae.report.query': args.push('analysis', 'report-data', 'run'); flag('report-ids', [a.reportId]); break;
    case 'ae.asset.getUrl': args.push('analysis-meta', 'asset', 'url-get'); flag('resource-id', a.reportId); flag('resource-type', 'report'); break;
    case 'ae.metadata.events': args.push('analysis-meta', 'event', 'list'); flag('queries', a.query ? [a.query] : undefined); flag('limit', 50); break;
    case 'ae.report.schema': return [...common, 'analysis', 'report', 'create', '--help'];
  }
  flag('project-id', Number(scope.projectId));
  return [...common, ...args];
}
export class CliError extends Error { constructor(message: string, public readonly unknownResult = false) { super(message); } }
export function parseEnvelope(stdout: string, stderr: string, code: number | null): unknown {
  const parse = (s: string) => { try { return JSON.parse(s.trim()); } catch { const start = s.indexOf('{'), end = s.lastIndexOf('}'); if (start >= 0 && end > start) try { return JSON.parse(s.slice(start, end + 1)); } catch {} return null; } };
  const out = parse(stdout), err = parse(stderr);
  const envelope = err?.ok === false ? err : out;
  if (envelope?.ok === false) {
    const error = envelope.error ?? {}, message = [error.message, error.hint].filter(Boolean).join(' · ') || 'CLI 操作失败';
    const status = Number(error.code); const definiteRejection = status >= 400 && status < 500 && ![408, 425, 429].includes(status);
    const ambiguous = /timeout|timed out|ECONNRESET|socket hang up|超时|connection.*closed/i.test(message) || (['api', 'network'].includes(error.type) && !definiteRejection);
    throw new CliError(message, ambiguous);
  }
  if (code !== 0) throw new CliError(`CLI 退出 ${code ?? 'unknown'}：${stderr.slice(0, 2000)}`, true);
  if (envelope?.ok !== true || !Object.hasOwn(envelope, 'data')) throw new CliError('CLI 未返回可确认的 JSON envelope', true);
  return envelope.data;
}
export interface ReportSnapshot { id: string; version: number; definition: Record<string, unknown>; modelType: string; name?: string; description?: string; }
export function reportSnapshot(value: unknown): ReportSnapshot {
  const root = value as any;
  const d = root?.report ?? root;
  const id = d?.report_id ?? d?.reportId ?? d?.id;
  const version = d?.version ?? d?.report_version;
  if (!id || !Number.isInteger(version) || !d?.definition || typeof d.definition !== 'object' || Array.isArray(d.definition)) throw new CliError('报表结果缺少 ID、version 或 AI definition；请检查 CLI/AE 版本', true);
  return { id: String(id), version, definition: d.definition, modelType: d.model_type, name: d.report_name, description: d.report_desc };
}
export function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [prefix || '/'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => changedPaths((before as any)[k], (after as any)[k], `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}
