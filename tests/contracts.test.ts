import { describe, it, expect } from 'vitest';
import { cliArgs, parseEnvelope, changedPaths, toolSchemas } from '../packages/ae-cli-adapter/index';
import { sameScope, safeURL, MAX_FRAME } from '../packages/contracts/index';
import { detectPage } from '../packages/page-adapters/index';
import { matchesPage, newerThan } from '../packages/sync-engine/index';
import { FrameDecoder, frame } from '../apps/native-host/protocol';
const scope = { origin: 'https://ae.example.com', projectId: '7', actorId: 'alice', tenantId: 'one' };
const change = { eventId: 'e1', operationId: 'o1', sequence: 1, createdAt: 1, scope, resource: { type: 'report' as const, id: '42' }, action: 'updated' as const, changedPaths: ['/definition/metrics'], affectedResources: [{ type: 'dashboard', id: '88' }] };
describe('CLI boundary', () => {
  it('passes untrusted text as one argument and freezes host/project', () => {
    const name = '$(touch /tmp/bad); --host evil';
    const args = cliArgs('ae.report.update', { reportId: 42, version: 3, name }, scope);
    expect(args[args.indexOf('--report-name') + 1]).toBe(name);
    expect(args[args.indexOf('--host') + 1]).toBe(scope.origin);
    expect(args[args.indexOf('--project-id') + 1]).toBe('7');
    expect(() => toolSchemas['ae.report.update'].parse({ reportId: 42, version: 3, name, projectId: '999' })).toThrow();
  });
  it('reads error envelopes from stderr and rejects unconfirmed success', () => {
    expect(() => parseEnvelope('', JSON.stringify({ ok: false, error: { message: 'version conflict', hint: 'read first' } }), 1)).toThrow('version conflict');
    expect(() => parseEnvelope('{"status":"accepted"}', '', 0)).toThrow('envelope');
    expect(parseEnvelope('{"ok":true,"data":{"id":42}}', 'warning', 0)).toEqual({ id: 42 });
    try { parseEnvelope('', '{"ok":false,"error":{"type":"api","message":"socket timeout"}}', 1); } catch (e: any) { expect(e.unknownResult).toBe(true); }
  });
  it('requires a model type for definition writes', () => {
    expect(() => cliArgs('ae.report.update', { reportId: 42, version: 2, definition: {} }, scope)).toThrow();
    expect(changedPaths({ definition: { event: 'a' }, name: 'x' }, { definition: { event: 'b' }, name: 'x' })).toEqual(['/definition/event']);
  });
});
describe('page routing and sync', () => {
  it('recognizes the actual AE project_report route', () => {
    const page = detectPage('https://ae.example.com/#/tga/event/7_42', scope)!;
    expect(page.resource).toEqual({ type: 'report', id: '42' }); expect(matchesPage(change, page)).toBe(true);
    expect(detectPage('https://ae.example.com/#/tga/event/8_42', scope)).toBeUndefined();
    expect(detectPage('https://evil.example.com/#/tga/event/7_42', scope)).toBeUndefined();
  });
  it('isolates accounts, tenants, projects and unrelated cards', () => {
    const page = detectPage('https://ae.example.com/#/reports/42?projectId=7', scope)!;
    for (const patch of [{ actorId: 'bob' }, { tenantId: 'two' }, { projectId: '8' }]) expect(matchesPage(change, { ...page, scope: { ...scope, ...patch } })).toBe(false);
    expect(matchesPage(change, { ...page, resource: { type: 'report', id: '43' } })).toBe(false);
    expect(newerThan({ ...change, sequence: 2 }, change)).toBe(true);
    expect(sameScope(scope, { ...scope, actorId: 'bob' })).toBe(false);
  });
  it('does not infer a project from an unrelated URL', () => { expect(detectPage('https://ae.example.com/#/reports', scope)).toBeUndefined(); });
});
describe('native protocol and endpoint policy', () => {
  it('decodes split and coalesced UTF-8 messages', () => { const decoder = new FrameDecoder(); const bytes = Buffer.concat([frame({ id: '1', text: '支付事件' }), frame({ id: '2' })]); expect(decoder.push(bytes.subarray(0, 7))).toEqual([]); expect(decoder.push(bytes.subarray(7))).toEqual([{ id: '1', text: '支付事件' }, { id: '2' }]); });
  it('rejects oversized messages and credential-bearing endpoints', () => { const h = Buffer.alloc(4); h.writeUInt32LE(MAX_FRAME + 1); expect(() => new FrameDecoder().push(h)).toThrow(); for (const url of ['http://evil.com', 'https://key@api.example.com', 'https://api.example.com?key=secret']) expect(() => safeURL(url)).toThrow(); expect(safeURL('http://localhost:3000/mcp').hostname).toBe('localhost'); });
});
