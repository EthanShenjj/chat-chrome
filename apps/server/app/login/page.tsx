import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, webSession } from '../../lib/sessions';
import LoginForm from './LoginForm';
export const dynamic = 'force-dynamic';
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const input = (await searchParams).next ?? '/workspace';
  let next = '/workspace';
  try { const url = new URL(input, 'https://return.invalid'); if (input.startsWith('/') && url.origin === 'https://return.invalid') next = `${url.pathname}${url.search}`; } catch {}
  let authenticated = false; try { await webSession((await cookies()).get(SESSION_COOKIE)?.value); authenticated = true; } catch {}
  if (authenticated) redirect(next);
  return <LoginForm next={next}/>;
}
