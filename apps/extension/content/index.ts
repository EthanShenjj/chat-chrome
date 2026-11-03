import { detectPage } from '../../../packages/page-adapters/index';
import { matchesPage } from '../../../packages/sync-engine/index';
import type { Scope, ResourceChanged } from '../../../packages/contracts/index';
// No page-to-extension command channel. This script can only answer context/sync requests.
if (!(globalThis as any).__aeChatContent) {
  (globalThis as any).__aeChatContent = true;
  let edited = false;
  document.addEventListener('input', e => { const target = e.target as HTMLElement; if (target.closest('input,textarea,[contenteditable="true"]')) edited = true; }, true);
  document.addEventListener('change', () => { edited = true; }, true);
  function context(scope: Scope) {
    let observedProject: string | undefined;
    // Existing AE storage contract, read only the selected project's ID; never tokens or credentials.
    try { const session = JSON.parse(sessionStorage.getItem('TA_CURRENT_PROJECT') || 'null'); const selected = session?.projectId ?? JSON.parse(localStorage.getItem('TA_LOCAL_STORAGE') || 'null')?.login?.project?.projectId; if (selected != null) observedProject = String(selected); } catch {}
    const page = detectPage(location.href, scope, document.title, observedProject); if (page) page.dirty = edited ? true : 'unknown'; return page;
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'page.context') { reply(context(message.scope)); return; }
    if (message.type === 'page.sync') {
      const change = message.change as ResourceChanged, page = context(change.scope);
      if (!page || !matchesPage(change, page)) { reply({ status: 'failed', detail: '页面已切换，不匹配该变更' }); return; }
      // No reliable dirty-state/definition-version API was found in the existing AE app.
      // A query-only refresh would keep the old definition, so require explicit reload.
      reply({ status: 'blocked', detail: edited ? '页面存在编辑操作，请先保存草稿，再应用最新版本' : '当前 AE 版本未提供已验证的局部刷新入口，请确认草稿后刷新页面' });
    }
  });
}
