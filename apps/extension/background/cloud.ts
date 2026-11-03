import { errorText, safeURL, type Snapshot } from '../../../packages/contracts/index';
export interface ServiceConnection { url: string; token: string; authMode?: 'cookie' | 'bearer'; expiresAt?: number; }
export class AuthenticationError extends Error {}
export class CloudBridge {
  private controller?: AbortController;
  private generation = 0;
  private credentialRevision = 0;
  constructor(private connection: ServiceConnection, private onSnapshot: (s: Snapshot) => void, private onError: (message: string, loginRequired?: boolean) => void) {}
  configure(connection: ServiceConnection) { if (!connection.url && !connection.token) { this.close(); this.credentialRevision++; this.connection = connection; return; } const url = safeURL(connection.url); if (url.pathname !== '/') throw new Error('服务地址请填写根域名，不含路径'); if (connection.token && !/^[A-Za-z0-9_-]{32,256}$/.test(connection.token)) throw new Error('服务凭证格式无效'); this.close(); this.credentialRevision++; this.connection = { ...connection, url: url.origin }; }
  get url() { return this.connection.url; }
  async request<T = any>(type: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.connection.url) throw new Error('请先在设置中填写线上服务地址');
    if (!this.connection.token && this.connection.authMode !== 'cookie') throw new AuthenticationError('请先登录服务网页');
    const revision = this.credentialRevision;
    const response = await fetch(`${this.connection.url}/api/rpc`, { method: 'POST', headers: { ...(this.connection.token ? { Authorization: `Bearer ${this.connection.token}` } : {}), 'Content-Type': 'application/json' }, credentials: this.connection.authMode === 'cookie' ? 'same-origin' : 'omit', body: JSON.stringify({ type, ...args }), signal: AbortSignal.timeout(350000), redirect: 'error', cache: 'no-store' });
    if (revision !== this.credentialRevision) throw new Error('登录身份已变化，请重试');
    if (response.status === 401) { this.close(); this.onError('登录已过期，请重新登录服务网页', true); throw new AuthenticationError('登录已过期，请重新登录服务网页'); }
    const reply = await response.json(); if (revision !== this.credentialRevision) throw new Error('登录身份已变化，请重试'); if (!response.ok || !reply.ok) throw new Error(reply.error || `服务返回 HTTP ${response.status}`); return reply.result;
  }
  close() { this.generation++; this.controller?.abort(); this.controller = undefined; }
  watch() { this.close(); const generation = this.generation; void this.watchLoop(generation); }
  private async watchLoop(generation: number) {
    let delay = 1000;
    while (generation === this.generation) {
      this.controller = new AbortController();
      try {
        const response = await fetch(`${this.connection.url}/api/events`, { headers: this.connection.token ? { Authorization: `Bearer ${this.connection.token}` } : {}, credentials: this.connection.authMode === 'cookie' ? 'same-origin' : 'omit', signal: this.controller.signal, cache: 'no-store', redirect: 'error' });
        if (generation !== this.generation) return;
        if (response.status === 401) { this.close(); this.onError('登录已过期，请重新登录服务网页', true); return; }
        if (!response.ok || !response.body) throw new Error(`服务订阅失败：HTTP ${response.status}`);
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (event.startsWith('event: state\n')) { const data = event.slice('event: state\ndata: '.length); if (generation === this.generation) this.onSnapshot(JSON.parse(data)); }
          }
          if (buffer.length > 16 * 1024 * 1024) throw new Error('服务状态数据过大');
        }
        delay = 1000;
      } catch (e) { if (generation !== this.generation) return; this.onError(errorText(e)); delay = Math.min(delay * 2, 30000); }
      if (generation !== this.generation) return;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
