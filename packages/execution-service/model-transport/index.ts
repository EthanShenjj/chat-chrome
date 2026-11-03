import { type ProviderConfig, safeURL } from '../../../packages/contracts/index';
import { credential } from '../storage';
import { assertAllowedOrigin } from '../context';
export async function modelRequest(provider: ProviderConfig, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const allowed = provider.protocol === 'openai-responses' ? '/responses' : '/chat/completions';
  if (path !== allowed) throw new Error('模型请求路径不允许');
  const base = safeURL(provider.baseURL);
  assertAllowedOrigin(base.href);
  const payload: Record<string, unknown> = { ...(body as Record<string, unknown>), model: provider.model };
  if (provider.protocol === 'openai-responses') { delete payload.previous_response_id; payload.store = false; }
  return fetch(`${base.toString().replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await credential(provider.credentialRef)}` },
    body: JSON.stringify(payload), signal, redirect: 'error'
  });
}
