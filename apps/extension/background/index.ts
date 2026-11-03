import { AuthenticationError, CloudBridge, type ServiceConnection } from './cloud';
import { LoginRequiredError, resumeWebLogin } from './login';
import { journal } from './db';
import { defaultConfig, errorText, safeURL, sameScope, ScopeSchema, type AeConnection, type Snapshot, type Session, type PageContext, type Delivery } from '../../../packages/contracts/index';
import { matchesPage, newerThan } from '../../../packages/sync-engine/index';

const emptySession = (): Session => ({ id: crypto.randomUUID(), title: '新的对话', messages: [], history: [], status: 'idle', updatedAt: Date.now() });
const guest = (): Snapshot => ({ config: defaultConfig, connected: false, session: emptySession(), operations: [], deliveries: [], approvals: [], providerId: '', auth: { status: 'unauthenticated' } });
let state: Snapshot = guest();
let connection: ServiceConnection = { url: '', token: '' };
let syncBusy = false;
const bridge = new CloudBridge(connection, snapshot => { void merge(snapshot); }, (_message, loginRequired) => { if (loginRequired) void markLoggedOut(); else { state.connected = false; broadcast(); } });
let connecting: Promise<Snapshot> | undefined;
const boot = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['serviceConnection']);
  if (saved.serviceConnection) {
    const previous = saved.serviceConnection as ServiceConnection;
    // Old manually entered API tokens do not substitute for a website login.
    connection = { url: previous.url, token: previous.token?.startsWith('ae_ext_') ? previous.token : '', expiresAt: previous.expiresAt };
    bridge.configure(connection);
  }
  await chrome.storage.local.remove('serviceSnapshot');
  state.serviceURL = connection.url;
  state.auth = { status: connection.url ? 'checking' : 'unauthenticated' };
  state.deliveries = await journal.deliveries();
})();
function broadcast() { void chrome.runtime.sendMessage({ type: 'state.changed', snapshot: state }).catch(() => {}); }
async function markLoggedOut() {
  connection = { url: connection.url, token: '' }; bridge.configure(connection);
  state = { ...guest(), serviceURL: connection.url };
  await chrome.storage.local.set({ serviceConnection: connection }); await chrome.storage.local.remove('serviceSnapshot'); broadcast();
}
async function merge(snapshot: Snapshot) {
  if (!connection.token) return;
  const sameUser = state.auth?.userId === snapshot.auth?.userId;
  state = { ...snapshot, aeConnection: sameUser ? state.aeConnection : undefined, page: sameUser ? state.page : undefined, deliveries: sameUser ? state.deliveries : [], connected: true, serviceURL: connection.url, auth: snapshot.auth ?? { status: 'authenticated' } };
  broadcast(); void syncChanges();
}
async function restoreLogin() {
  const result = await resumeWebLogin(connection.url);
  connection = { url: connection.url, token: result.token, expiresAt: result.expiresAt };
  bridge.configure(connection); await chrome.storage.local.set({ serviceConnection: connection });
}
async function connect(): Promise<Snapshot> {
  if (connecting) return connecting;
  connecting = (async () => {
    if (!connection.url) throw new Error('请先在设置中填写服务地址');
    try {
      if (!connection.token || !connection.expiresAt || connection.expiresAt <= Date.now()) await restoreLogin();
      let snapshot: Snapshot;
      try { snapshot = await bridge.request<Snapshot>('state.get'); }
      catch (e) { if (!(e instanceof AuthenticationError)) throw e; await restoreLogin(); snapshot = await bridge.request<Snapshot>('state.get'); }
      await merge(snapshot); if (state.config.aeOrigin && state.session.status !== 'running') await refreshAe(state.config.aeOrigin); await currentPage(); bridge.watch(); return state;
    } catch (e) {
      if (e instanceof LoginRequiredError || e instanceof AuthenticationError) { await markLoggedOut(); return state; }
      state.connected = false; broadcast(); throw e;
    }
  })();
  try { return await connecting; } finally { connecting = undefined; }
}
async function aeTab(origin: string) {
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.url && new URL(tab.url).origin === origin);
  return tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}
async function discoverAe(origin: string): Promise<AeConnection> {
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return { status: 'page-required', message: '请先允许扩展访问这个 AE 环境' };
  const tab = await aeTab(origin);
  if (!tab?.id) return { status: 'page-required', message: '请打开该 AE 环境并登录，然后重新识别' };
  try {
    const request = { type: 'workspace.discover.v2', origin };
    let result: AeConnection;
    try { result = await chrome.tabs.sendMessage(tab.id, request); if (!result?.status) throw new Error('旧版页面脚本不支持工作区识别'); }
    catch { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); result = await chrome.tabs.sendMessage(tab.id, request); }
    if (result.status === 'ready') { result.scope = ScopeSchema.parse(result.scope); if (result.scope.origin !== origin) throw new Error('环境不匹配'); }
    return result;
  } catch (error) { const reason = errorText(error).replace(/https?:\/\/[^\s"<>]+/g, '该 AE 页面').slice(0, 180); return { status: 'unavailable', message: `无法识别 AE 页面：${reason}。请等待页面加载完成后重新识别` }; }
}
async function refreshAe(origin: string) {
  const result = await discoverAe(origin), scope = result.status === 'ready' ? result.scope! : null;
  const current = state.config.binding;
  if (state.config.aeOrigin !== origin || Boolean(current) !== Boolean(scope) || (current && scope && !sameScope(current, scope))) await merge(await bridge.request<Snapshot>('workspace.connect', { origin, ...(scope ? { scope } : {}) }));
  state.aeConnection = result; broadcast(); return state;
}
async function pageAt(tabId: number): Promise<PageContext | undefined> {
  const scope = state.config.binding; if (!scope) return;
  try {
    const tab = await chrome.tabs.get(tabId); if (!tab.url || new URL(tab.url).origin !== scope.origin) return;
    try { return await chrome.tabs.sendMessage(tabId, { type: 'page.context.v2', scope }); }
    catch { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return await chrome.tabs.sendMessage(tabId, { type: 'page.context.v2', scope }); }
  } catch { return; }
}
async function currentPage() { const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); state.page = tab?.id ? await pageAt(tab.id) : undefined; }
async function saveDelivery(d: Delivery) { d.updatedAt = Date.now(); const index = state.deliveries.findIndex(x => x.id === d.id); if (index < 0) state.deliveries.push(d); else state.deliveries[index] = d; await journal.saveDelivery(d); broadcast(); }
async function syncChanges() {
  if (syncBusy) return; syncBusy = true;
  try {
    const changes = state.operations.filter(o => o.event).map(o => o.event!);
    if (!changes.length) return;
    for (const tab of await chrome.tabs.query({})) {
      if (!tab.id) continue; const page = await pageAt(tab.id); if (!page) continue;
      for (const change of changes.filter(c => matchesPage(c, page))) {
        const id = `${change.eventId}:${tab.id}`;
        const d = state.deliveries.find(x => x.id === id) ?? { id, eventId: change.eventId, tabId: tab.id, status: 'pending' as const, attempts: 0, updatedAt: Date.now() };
        if (changes.some(c => newerThan(c, change))) { if (d.status !== 'superseded') { d.status = 'superseded'; await saveDelivery(d); } continue; }
        if (['synced', 'blocked', 'unverified', 'superseded'].includes(d.status) || d.attempts >= 3) continue;
        d.status = 'received'; d.attempts++; await saveDelivery(d);
        try { const result = await chrome.tabs.sendMessage(tab.id, { type: 'page.sync.v2', change }); d.status = result.status; d.detail = result.detail; }
        catch (e) { d.status = 'failed'; d.detail = errorText(e); }
        await saveDelivery(d);
      }
    }
  } finally { syncBusy = false; }
}
async function handle(message: any): Promise<any> {
  await boot;
  switch (message.type) {
    case 'state.get': if (connection.url) try { await connect(); } catch {} await currentPage(); return state;
    case 'service.connect': {
      if (state.session.status === 'running') throw new Error('请先停止当前任务后切换服务');
      const url = safeURL(message.url); if (url.pathname !== '/') throw new Error('服务地址请填写根域名');
      if (!(await chrome.permissions.contains({ origins: [`${url.origin}/*`] }))) throw new Error('请允许扩展访问服务域名');
      if (url.origin !== connection.url) { bridge.close(); connection = { url: url.origin, token: '' }; state = { ...guest(), serviceURL: connection.url }; bridge.configure(connection); }
      await chrome.storage.local.set({ serviceConnection: connection }); return connect();
    }
    case 'auth.openLogin': {
      if (!connection.url) throw new Error('请先填写服务地址');
      await chrome.tabs.create({ url: new URL('/login?next=/workspace', connection.url).href }); return { opened: true };
    }
    case 'auth.check': return connection.url ? connect() : state;
    case 'service.reconnect': return connect();
    case 'service.disconnect': bridge.close(); connection = { url: '', token: '' }; state = guest(); await chrome.storage.local.remove(['serviceConnection', 'serviceSnapshot']); broadcast(); return state;
    case 'workspace.connect': {
      const url = safeURL(message.origin); if (url.origin !== message.origin) throw new Error('AE 环境请填写根域名，不含路径');
      await connect(); if (state.session.status === 'running') throw new Error('请先停止当前任务后更换 AE 环境');
      return refreshAe(url.origin);
    }
    case 'workspace.refresh': if (!state.config.aeOrigin) throw new Error('请先保存 AE 环境地址'); await connect(); return state;
    case 'workspace.openAE': {
      const origin = safeURL(message.origin || state.config.aeOrigin || state.config.binding?.origin).origin;
      const tab = await aeTab(origin); if (tab?.id) await chrome.tabs.update(tab.id, { active: true }); else await chrome.tabs.create({ url: origin }); return { opened: true };
    }
    case 'chat.send': await connect(); if (state.auth?.status !== 'authenticated') throw new AuthenticationError('请先登录服务网页，再继续对话'); await currentPage(); { const result = await bridge.request('chat.send', { text: message.text, page: state.page }); await merge(await bridge.request('state.get')); bridge.watch(); return result; }
    case 'config.save': {
      if (message.config?.binding) { const origin = safeURL(message.config.binding.origin).origin; if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) throw new Error('请允许扩展访问 AE 环境'); }
      await bridge.request('config.save', { config: message.config }); await merge(await bridge.request('state.get')); return state;
    }
    case 'sync.retry': { const d = state.deliveries.find(x => x.id === message.id); if (!d) throw new Error('同步记录不存在'); d.status = 'pending'; d.attempts = 0; await saveDelivery(d); await syncChanges(); return state; }
    case 'sync.reload': {
      const d = state.deliveries.find(x => x.id === message.id), change = state.operations.find(o => o.event?.eventId === d?.eventId)?.event;
      if (!d || !change) throw new Error('同步记录不存在'); const page = await pageAt(d.tabId); if (!page || !matchesPage(change, page)) throw new Error('页面已切换，取消刷新');
      d.status = 'unverified'; d.detail = '已确认并刷新页面；当前适配器无法验证图表定义版本'; await saveDelivery(d); await chrome.tabs.reload(d.tabId); return state;
    }
    default: {
      const allowed = ['chat.stop', 'chat.new', 'sessions.list', 'sessions.load', 'provider.select', 'provider.test', 'credential.save', 'auth.save', 'auth.status', 'auth.login.start', 'auth.login.check', 'auth.login.cancel', 'auth.cli.status', 'cli.probe', 'mcp.list', 'mcp.disconnect', 'approval.resolve', 'operations.reconcile'];
      if (!allowed.includes(message.type)) throw new Error('未知或未授权的消息');
      const { type, ...params } = message; const result = await bridge.request(type, params);
      if (result?.session) { await merge(result); return state; }
      return result;
    }
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !/\/(sidepanel|options)\.html(?:[?#]|$)/.test(sender.url)) return;
  if (message.type === 'state.changed') return;
  handle(message).then(result => reply({ ok: true, result }), e => reply({ ok: false, error: errorText(e) })); return true;
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create('cloud-recovery', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { void boot.then(async () => { if (connection.url) try { await connect(); } catch { state.connected = false; broadcast(); } }); });
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete') void boot.then(async () => { if (connection.url && tab.url?.startsWith(connection.url + '/')) try { await connect(); broadcast(); } catch {} await syncChanges(); }); });
chrome.tabs.onActivated.addListener(() => { void boot.then(async () => { await currentPage(); broadcast(); }); });
void boot.then(async () => { if (connection.url) try { await connect(); } catch { state.connected = false; } });
