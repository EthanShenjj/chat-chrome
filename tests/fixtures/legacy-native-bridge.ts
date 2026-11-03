export class NativeBridge {
  private port?: chrome.runtime.Port;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; json: string; controller?: ReadableStreamDefaultController<Uint8Array>; timer: ReturnType<typeof setTimeout>; cleanup?: () => void }>();
  connected = false;
  constructor(private onDisconnect: () => void = () => {}) {}
  connect() {
    if (this.port) return;
    this.port = chrome.runtime.connectNative('com.ae.chat.agent');
    this.port.onMessage.addListener(m => this.receive(m));
    this.port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || '本地执行器连接中断'; this.port = undefined; this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.cleanup?.(); p.controller?.error(new Error(error)); p.reject(new Error(error)); }
      this.pending.clear(); this.onDisconnect();
    });
  }
  request<T = any>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    this.connect();
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID();
      const abort = () => { this.port?.postMessage({ id: crypto.randomUUID(), method: 'cancel', params: { id } }); const p = this.pending.get(id); if (p) { clearTimeout(p.timer); p.cleanup?.(); p.controller?.error(new DOMException('已停止', 'AbortError')); p.reject(new DOMException('已停止', 'AbortError')); this.pending.delete(id); } };
      const timer = setTimeout(() => { abort(); reject(new Error('执行器请求超时；写操作请先核实结果')); }, ['auth.login', 'cli.install'].includes(method) ? 330000 : 240000);
      this.pending.set(id, { resolve, reject, json: '', timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try { this.port!.postMessage({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private receive(m: any) {
    const p = this.pending.get(m.id); if (!p) return; this.connected = true;
    if (m.type === 'headers') { const stream = new ReadableStream<Uint8Array>({ start: c => { p.controller = c; } }); p.resolve(new Response(stream, { status: m.status, headers: { 'Content-Type': 'text/event-stream' } })); return; }
    if (m.type === 'chunk') { const bytes = Uint8Array.from(atob(m.chunk), c => c.charCodeAt(0)); p.controller?.enqueue(bytes); return; }
    if (m.type === 'json-chunk') { p.json += m.chunk; return; }
    clearTimeout(p.timer); p.cleanup?.(); this.pending.delete(m.id);
    if (m.type === 'end') p.controller?.close();
    else if (m.type === 'error') { const error = Object.assign(new Error(m.error), { nativeReply: true, unknownResult: Boolean(m.unknownResult) }); p.controller?.error(error); p.reject(error); }
    else if (m.type === 'json-end') { try { p.resolve(JSON.parse(p.json)); } catch (e) { p.reject(new Error('执行器消息解析失败')); } }
    else p.resolve(m.result);
  }
  fetch = (providerId: string): typeof fetch => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.endsWith('/responses') ? '/responses' : '/chat/completions';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return this.request<Response>('model.request', { providerId, path, body }, init?.signal ?? undefined);
  };
}
