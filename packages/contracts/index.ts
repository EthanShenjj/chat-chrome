import { z } from 'zod';

export const ScopeSchema = z.object({ origin: z.url(), projectId: z.string().regex(/^\d+$/), actorId: z.string().min(1), tenantId: z.string().optional() });
export type Scope = z.infer<typeof ScopeSchema>;
export const ProviderSchema = z.object({
  id: z.string().regex(/^[\w-]+$/), name: z.string().min(1),
  protocol: z.enum(['openai-responses', 'openai-chat-completions']),
  baseURL: z.url(), model: z.string().min(1), credentialRef: z.string().regex(/^[\w.-]+$/),
  capabilities: z.object({ streaming: z.boolean(), toolCalling: z.boolean(), structuredOutput: z.boolean(), parallelToolCalls: z.boolean(), vision: z.boolean() })
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;
export const McpSchema = z.object({
  id: z.string().regex(/^[\w-]+$/), name: z.string().min(1), enabled: z.boolean(),
  transport: z.enum(['stdio', 'http']), url: z.string().optional(), command: z.string().optional(),
  args: z.array(z.string()).default([]), credentialRef: z.string().regex(/^[\w.-]+$/).optional(),
  allowedTools: z.array(z.string()).default([])
});
export type McpConfig = z.infer<typeof McpSchema>;
export const HostConfigSchema = z.object({
  cliPath: z.string().min(1).default('ae-cli'), binding: ScopeSchema.nullable().default(null),
  aeOrigin: z.url().optional(), aeAuthScope: ScopeSchema.optional(),
  providers: z.array(ProviderSchema).default([]), mcps: z.array(McpSchema).default([])
});
export type HostConfig = z.infer<typeof HostConfigSchema>;
export const defaultConfig: HostConfig = { cliPath: 'ae-cli', binding: null, providers: [], mcps: [] };
export const defaultProvider: ProviderConfig = {
  id: 'openai', name: 'OpenAI', protocol: 'openai-responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1', credentialRef: 'openai',
  capabilities: { streaming: true, toolCalling: false, structuredOutput: true, parallelToolCalls: false, vision: false }
};
export interface PageContext { scope: Scope; resource?: { type: 'report' | 'dashboard' | 'report-list'; id: string }; title: string; url: string; dirty: boolean | 'unknown'; adapter: string; version?: string; }
export interface ResourceChanged {
  eventId: string; operationId: string; sequence: number; createdAt: number; scope: Scope;
  resource: { type: 'report'; id: string }; action: 'created' | 'updated'; changedPaths: string[];
  beforeVersion?: string; afterVersion?: string; afterDefinitionHash?: string;
  affectedResources: { type: string; id: string }[];
}
export type SyncStatus = 'pending' | 'received' | 'refreshing' | 'unverified' | 'synced' | 'blocked' | 'failed' | 'superseded';
export interface Delivery { id: string; eventId: string; tabId: number; status: SyncStatus; attempts: number; updatedAt: number; detail?: string; }
export interface Operation { id: string; taskId: string; tool: string; scope: Scope; args: Record<string, unknown>; state: 'running' | 'completed' | 'failed' | 'unknown'; startedAt: number; result?: unknown; error?: string; event?: ResourceChanged; }
export interface Message { id: string; role: 'user' | 'assistant'; text: string; createdAt: number; }
export interface Approval { id: string; taskId: string; label: string; details: unknown; }
export interface Session { id: string; title: string; messages: Message[]; history: unknown[]; status: 'idle' | 'running' | 'interrupted' | 'failed'; error?: string; scope?: Scope; updatedAt: number; }
export interface LoginState { status: 'checking' | 'authenticated' | 'unauthenticated'; userId?: string; }
export interface AeConnection { status: 'ready' | 'login-required' | 'project-required' | 'page-required' | 'unavailable'; message: string; scope?: Scope; accountName?: string; projectName?: string; }
export interface AeCliAuthState { status: 'not-authorized' | 'pending' | 'authenticated' | 'expired' | 'denied' | 'cancelled' | 'unverified' | 'account-mismatch' | 'error'; message: string; origin?: string; verificationURL?: string; userCode?: string; expiresAt?: number; pollIntervalMs?: number; accountName?: string; checkedAt?: number; }
export interface Snapshot { config: HostConfig; connected: boolean; session: Session; operations: Operation[]; deliveries: Delivery[]; approvals: Approval[]; page?: PageContext; providerId: string; serviceURL?: string; auth?: LoginState; aeConnection?: AeConnection; aeCliAuth?: AeCliAuthState; }
export function sameAeIdentity(a: Scope, b?: Scope) { return Boolean(b && a.origin === b.origin && a.actorId === b.actorId && (a.tenantId ?? '') === (b.tenantId ?? '')); }
export type WireReply = { id: string; type: 'result'; result: unknown } | { id: string; type: 'error'; error: string } | { id: string; type: 'headers'; status: number } | { id: string; type: 'chunk'; chunk: string } | { id: string; type: 'end' };
export const MAX_FRAME = 768 * 1024;
export function sameScope(a: Scope, b: Scope) { return a.origin === b.origin && a.projectId === b.projectId && a.actorId === b.actorId && (a.tenantId ?? '') === (b.tenantId ?? ''); }
export function errorText(e: unknown) { return e instanceof Error ? e.message : String(e); }
export function safeURL(raw: string) { const url = new URL(raw); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('请使用 HTTPS；仅本机地址允许 HTTP'); if (url.username || url.password || url.search || url.hash) throw new Error('连接地址不能含认证信息、查询参数或片段'); return url; }
