import { safeURL, type AeConnection } from '../contracts/index';
interface StorageReader { getItem(key: string): string | null; }
interface Options { origin: string; url: string; local: StorageReader; session: StorageReader; fetch: typeof fetch; }
function stored(storage: StorageReader, key: string): any {
  try { const raw = storage.getItem(key); if (raw === null) return undefined; try { return JSON.parse(raw); } catch { return raw; } } catch { return undefined; }
}
export async function discoverAeContext(o: Options): Promise<AeConnection> {
  const login = (): AeConnection => ({ status: 'login-required', message: '请在 AE 网页登录，再重新识别工作区' });
  let origin: string, url: URL;
  try { origin = safeURL(o.origin).origin; url = new URL(o.url); } catch { return { status: 'unavailable', message: 'AE 环境地址无效' }; }
  if (url.origin !== origin) return { status: 'page-required', message: '请打开所填写的 AE 环境' };
  if (/^#?\/(?:login|ssologin|logout)(?:[/?]|$)/i.test(url.hash || url.pathname) || /(?:[?&])isShortLinkModel=1(?:&|$)/.test(url.href)) return login();
  // Use the AE page's existing credential only for a same-origin login check.
  // Neither the credential nor the full login response leaves this content script.
  const token = stored(o.local, 'ACCESS_TOKEN');
  if (typeof token !== 'string' || !token) return login();
  try {
    const prefix = stored(o.local, 'bff') === true ? '/bff/v1' : '/v1';
    const response = await o.fetch(`${origin}${prefix}/oauth/check`, { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: '', signal: AbortSignal.timeout(10000) });
    if (response.status === 401 || response.status === 403) return login();
    if (!response.ok) return { status: 'unavailable', message: 'AE 登录校验暂不可用，请稍后重新识别' };
    const result = await response.json() as any, user = result.data;
    if ((result.return_code !== undefined && result.return_code !== 0) || !user?.loginName || user.userId == null || String(user.userId) === '-1') return login();
    const selected = stored(o.session, 'TA_CURRENT_PROJECT') ?? stored(o.local, 'TA_LOCAL_STORAGE')?.login?.project;
    const route = url.hash.replace(/^#/, '') || `${url.pathname}${url.search}`, query = new URLSearchParams(route.split('?')[1] ?? url.search);
    const projectId = route.match(/\/(?:tga\/[^/]+|panel\/panel)\/(\d+)_\d+/)?.[1] ?? query.get('projectId') ?? query.get('project_id') ?? query.get('pid') ?? route.match(/\/project\/(\d+)/)?.[1] ?? selected?.projectId;
    const projects = Array.isArray(user.projectInfoList) ? user.projectInfoList : [];
    const project = projectId != null ? projects.find((p: any) => String(p.projectId) === String(projectId)) : projects.length === 1 ? projects[0] : undefined;
    if (!project || !/^\d+$/.test(String(project.projectId))) return { status: 'project-required', message: '请在 AE 网页选择有权限的项目，再重新识别' };
    return { status: 'ready', message: '已识别当前 AE 登录账号与项目', scope: { origin, projectId: String(project.projectId), actorId: String(user.userId), ...(project.companyId != null ? { tenantId: String(project.companyId) } : {}) }, accountName: String(user.loginName), projectName: String(project.projectName ?? `项目 ${project.projectId}`) };
  } catch { return { status: 'unavailable', message: '无法校验 AE 登录状态，请确认页面已登录后重新识别' }; }
}
