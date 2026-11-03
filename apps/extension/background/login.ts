export class LoginRequiredError extends Error {}
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function resumeWebLogin(origin: string): Promise<{ token: string; expiresAt: number; user: { id: string } }> {
  const verifier = random(), state = random(), redirectURI = chrome.identity.getRedirectURL('ae-auth');
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const authorize = new URL('/api/auth/authorize', origin);
  for (const [key, value] of Object.entries({ client_id: chrome.runtime.id, redirect_uri: redirectURI, state, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
  let callback: string | undefined;
  try { callback = await chrome.identity.launchWebAuthFlow({ url: authorize.href, interactive: false, timeoutMsForNonInteractive: 5000 }); }
  catch { throw new LoginRequiredError('请先登录服务网页，再继续对话'); }
  if (!callback) throw new LoginRequiredError('请先登录服务网页');
  const result = new URL(callback);
  if (`${result.origin}${result.pathname}` !== redirectURI || result.searchParams.get('state') !== state || !result.searchParams.get('code')) throw new Error('登录回调校验失败，请重新登录');
  const response = await fetch(`${origin}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000), body: JSON.stringify({ code: result.searchParams.get('code'), verifier, clientId: chrome.runtime.id, redirectURI }) });
  const data = await response.json(); if (!response.ok || !data.ok) throw new LoginRequiredError(data.error || '登录已失效，请重新登录网页');
  return data;
}
