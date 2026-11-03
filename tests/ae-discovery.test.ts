import { expect, test, vi } from 'vitest';
import { discoverAeContext } from '../packages/page-adapters/discovery';
const origin = 'https://ae.example.com';
const local = { getItem: (key: string) => key === 'ACCESS_TOKEN' ? '"private-browser-session"' : key === 'TA_LOCAL_STORAGE' ? JSON.stringify({ login: { user: { userId: 999 }, project: { projectId: 2 } } }) : null };
const session = { getItem: (key: string) => key === 'TA_CURRENT_PROJECT' ? '{"projectId":2}' : null };
const user = { userId: 42, loginName: 'actual-ae-account', projectInfoList: [{ projectId: 2, projectName: 'Demo', companyId: 7 }] };
test('derives scope from the authenticated AE response without returning browser credentials', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ return_code: 0, data: user }));
  const result = await discoverAeContext({ origin, url: `${origin}/#/tga/event/2_18`, local, session, fetch: fetcher });
  expect(result).toMatchObject({ status: 'ready', scope: { origin, actorId: '42', projectId: '2', tenantId: '7' } });
  expect(fetcher.mock.calls[0][0]).toBe(`${origin}/v1/oauth/check`);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('bearer private-browser-session');
  expect(JSON.stringify(result)).not.toContain('private-browser-session');
});
test('does not treat cached account metadata as a valid login', async () => {
  const result = await discoverAeContext({ origin, url: origin, local, session, fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })) });
  expect(result.status).toBe('login-required');
});
test('does not bind a project that is absent from the authenticated permission list', async () => {
  const result = await discoverAeContext({ origin, url: `${origin}/#/tga/event/9_18`, local, session, fetch: vi.fn().mockResolvedValue(Response.json({ return_code: 0, data: user })) });
  expect(result.status).toBe('project-required');
});
test('does not send credentials when the page is outside the configured AE environment', async () => {
  const fetcher = vi.fn();
  const result = await discoverAeContext({ origin, url: 'https://different.example.com/', local, session, fetch: fetcher });
  expect(result.status).not.toBe('ready'); expect(fetcher).not.toHaveBeenCalled();
});
