import { detectPage } from '../../../packages/page-adapters/index';
import { matchesPage } from '../../../packages/sync-engine/index';
import type { Scope, ResourceChanged } from '../../../packages/contracts/index';
import { discoverAeContext } from '../../../packages/page-adapters/discovery';
// No page-to-extension command channel. This script can only answer context/sync requests.
{
  const tracker = (globalThis as any).__aeChatTracker ??= { edited: false, attached: false, handler: undefined };
  if (!tracker.attached) {
    document.addEventListener('input', e => { const target = e.target as HTMLElement; if (target.closest('input,textarea,[contenteditable="true"]')) tracker.edited = true; }, true);
    document.addEventListener('change', () => { tracker.edited = true; }, true);
    tracker.attached = true;
  }
  // A reloaded extension must re-register its receiver even if this page survived.
  if (tracker.handler) try { chrome.runtime.onMessage.removeListener(tracker.handler); } catch {}

  function context(scope: Scope) {
    let observedProject: string | undefined;
    // Existing AE storage contract, read only the selected project's ID; never tokens or credentials.
    try { const local = JSON.parse(localStorage.getItem('TA_LOCAL_STORAGE') || 'null'); if (String(local?.login?.user?.userId) !== scope.actorId) return; const session = JSON.parse(sessionStorage.getItem('TA_CURRENT_PROJECT') || 'null'); const selected = session?.projectId ?? local?.login?.project?.projectId; if (selected != null) observedProject = String(selected); } catch { return; }
    const page = detectPage(location.href, scope, document.title, observedProject); if (page) page.dirty = tracker.edited ? true : 'unknown'; return page;
  }
  const handler: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'workspace.discover.v2') { void discoverAeContext({ origin: message.origin, url: location.href, local: localStorage, session: sessionStorage, fetch: globalThis.fetch.bind(globalThis) }).then(reply, () => reply({ status: 'unavailable', message: '无法识别 AE 工作区' })); return true; }
    if (message.type === 'page.context.v2') { reply(context(message.scope)); return; }
    if (message.type === 'page.sync.v2') {
      const change = message.change as ResourceChanged, page = context(change.scope);
      if (!page || !matchesPage(change, page)) { reply({ status: 'failed', detail: '页面已切换，不匹配该变更' }); return; }
      // No reliable dirty-state/definition-version API was found in the existing AE app.
      // A query-only refresh would keep the old definition, so require explicit reload.
      reply({ status: 'blocked', detail: tracker.edited ? '页面存在编辑操作，请先保存草稿，再应用最新版本' : '当前 AE 版本未提供已验证的局部刷新入口，请确认草稿后刷新页面' });
    }
  };
  chrome.runtime.onMessage.addListener(handler);
  tracker.handler = handler;
}
