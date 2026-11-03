import { defaultConfig, type Snapshot } from '../../../packages/contracts/index';
import { AuthenticationError, CloudBridge } from '../background/cloud';
export const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
export const isWebApp = typeof window !== 'undefined' && location.pathname === '/workspace';
const preview: Snapshot = { config: defaultConfig, connected: false, session: { id: 'preview', title: '新的对话', status: 'idle', messages: [], history: [], updatedAt: Date.now() }, operations: [], deliveries: [], approvals: [], providerId: '', serviceURL: isWebApp ? location.origin : undefined, auth: { status: 'unauthenticated' } };
const web = new CloudBridge({ url: isWebApp ? location.origin : '', token: '', authMode: 'cookie' }, snapshot => window.dispatchEvent(new CustomEvent('ae-cloud-state', { detail: snapshot })), (_message, loginRequired) => { if (loginRequired) window.dispatchEvent(new CustomEvent('ae-cloud-state', { detail: preview })); });
// Remove credentials left behind by the previous manual-token UI.
if (isWebApp) sessionStorage.removeItem('ae-service-token');
export async function request<T = any>(type: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isExtension) { const reply = await chrome.runtime.sendMessage({ type, ...args }); if (!reply?.ok) throw new Error(reply?.error || '扩展后台未响应'); return reply.result; }
  if (!isWebApp) { if (['state.get', 'auth.check'].includes(type)) return preview as T; throw new Error('当前为静态预览，请加载 Chrome 扩展或打开 Next.js /workspace'); }
  if (type === 'auth.openLogin') { window.open('/login?next=/workspace', '_blank', 'noopener'); return { opened: true } as T; }
  if (type === 'auth.logout') { const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}' }); if (!response.ok) throw new Error('退出登录失败，请重试'); web.close(); location.replace('/login'); return { loggedOut: true } as T; }
  if (['service.connect', 'service.reconnect', 'auth.check', 'state.get'].includes(type)) {
    try { const state = await web.request<Snapshot>('state.get'); web.watch(); return { ...state, serviceURL: location.origin } as T; }
    catch (e) { if (e instanceof AuthenticationError) return preview as T; throw e; }
  }
  if (type === 'service.disconnect') { web.close(); return preview as T; }
  const result = await web.request<any>(type, args); return (result?.session ? { ...result, serviceURL: location.origin } : result) as T;
}
