import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, webSession } from '../../lib/sessions';
import WorkspaceClient from './WorkspaceClient';
export const dynamic = 'force-dynamic';
export default async function Workspace() {
  let authenticated = false; try { await webSession((await cookies()).get(SESSION_COOKIE)?.value); authenticated = true; } catch {}
  if (!authenticated) redirect('/login?next=/workspace');
  return <WorkspaceClient/>;
}
