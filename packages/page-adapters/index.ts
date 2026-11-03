import { type PageContext, type Scope } from '../contracts/index';
// URL identity is a hint. Writes require the independently confirmed native-host binding.
export function detectPage(url: string, scope: Scope, title = '', observedProject?: string): PageContext | undefined {
  const u = new URL(url); if (u.origin !== scope.origin) return;
  const route = u.hash.replace(/^#/, '') || `${u.pathname}${u.search}`;
  const query = new URLSearchParams(route.split('?')[1] ?? u.search);
  const savedReport = route.match(/\/tga\/(?:event|funnel|retention|distribution|attribution|interval|path|prop_analysis|sql|ide|heatmap|revenue|rank|scatter|trace|property)\/(\d+)_(\d+)(?:[/?#]|$)/);
  const savedDashboard = route.match(/\/panel\/panel\/(\d+)_(\d+)(?:[_/?#]|$)/);
  const project = savedReport?.[1] ?? savedDashboard?.[1] ?? query.get('projectId') ?? query.get('project_id') ?? query.get('pid') ?? route.match(/\/project\/(\d+)/)?.[1] ?? observedProject;
  if (!project || project !== scope.projectId) return;
  if (observedProject && observedProject !== project) return;
  const report = savedReport?.[2] ?? query.get('reportId') ?? query.get('report_id') ?? route.match(/\/reports?\/(\d+)/)?.[1];
  const dashboard = savedDashboard?.[2] ?? query.get('dashboardId') ?? query.get('dashboard_id');
  const resource = report ? { type: 'report' as const, id: report } : dashboard ? { type: 'dashboard' as const, id: dashboard } : /\/reports(?:\?|\/|$)/.test(route) ? { type: 'report-list' as const, id: 'list' } : undefined;
  return { scope: { ...scope }, resource, title, url, dirty: 'unknown', adapter: 'ae-conservative-v1' };
}
