import { sameScope, type ResourceChanged, type PageContext } from '../contracts/index';
export function matchesPage(change: ResourceChanged, page: PageContext): boolean {
  if (!sameScope(change.scope, page.scope) || !page.resource) return false;
  if (page.resource.type === 'report-list') return true;
  if (page.resource.type === change.resource.type && page.resource.id === change.resource.id) return true;
  return change.affectedResources.some(r => r.type === page.resource?.type && r.id === page.resource.id);
}
export function newerThan(a: ResourceChanged, b: ResourceChanged): boolean {
  return sameScope(a.scope, b.scope) && a.resource.type === b.resource.type && a.resource.id === b.resource.id && a.sequence > b.sequence;
}
