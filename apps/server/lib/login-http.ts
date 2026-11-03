import { z } from 'zod';
import { HttpError, sameOrigin, corsHeaders, rateLimitUser, requestOrigin } from './auth';
import { SESSION_COOKIE, cookieToken, webSession, createWebSession, revokeWebSession, verifyPassword, createAuthorization, exchangeAuthorization } from './sessions';
import { errorText } from '../../../packages/contracts/index';
async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求');
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, '请求内容为空');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); throw new HttpError(413, '请求内容过大'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求格式无效'); }
}
function failure(e: unknown, headers: Record<string, string> = {}) { return Response.json({ ok: false, error: e instanceof z.ZodError ? '请输入有效的账号和密码' : errorText(e) }, { status: e instanceof HttpError ? e.status : 400, headers: { ...headers, 'Cache-Control': 'no-store' } }); }
function sessionCookie(request: Request, value: string, age: number) {
  const secure = new URL(requestOrigin(request)).protocol === 'https:';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
}
export async function login(request: Request) {
  try {
    sameOrigin(request);
    const { id, password } = z.object({ id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/), password: z.string().min(1).max(256) }).parse(await body(request));
    const user = await verifyPassword(id, password); await revokeWebSession(cookieToken(request));
    const session = await createWebSession(user);
    return Response.json({ ok: true, user: { id: user.id } }, { headers: { 'Set-Cookie': sessionCookie(request, session.token, 8 * 60 * 60), 'Cache-Control': 'no-store' } });
  } catch (e) { return failure(e); }
}
export async function logout(request: Request) { try { sameOrigin(request); await revokeWebSession(cookieToken(request)); return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(request, '', 0), 'Cache-Control': 'no-store' } }); } catch (e) { return failure(e); } }
export async function sessionStatus(request: Request) { try { const { user, session } = await webSession(cookieToken(request)); return Response.json({ authenticated: true, user: { id: user.id }, expiresAt: session.expiresAt }, { headers: { 'Cache-Control': 'no-store' } }); } catch (e) { return failure(e); } }
export async function authorize(request: Request) {
  try {
    const url = new URL(request.url), clientId = url.searchParams.get('client_id') ?? '', redirectURI = url.searchParams.get('redirect_uri') ?? '';
    const { extensionClient } = await import('./sessions'); extensionClient(clientId, redirectURI);
    const state = url.searchParams.get('state'); if (!state || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || url.searchParams.get('code_challenge_method') !== 'S256') throw new HttpError(400, '授权参数无效');
    let session;
    try { session = await webSession(cookieToken(request)); }
    catch { const target = new URL('/login', requestOrigin(request)); target.searchParams.set('next', `${url.pathname}${url.search}`); return Response.redirect(target, 302); }
    rateLimitUser(session.user.id);
    const code = await createAuthorization(session.sessionHash, clientId, redirectURI, url.searchParams.get('code_challenge') ?? '');
    const callback = new URL(redirectURI); callback.searchParams.set('code', code); callback.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: callback.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  } catch (e) { return failure(e); }
}
export async function exchange(request: Request) {
  let headers: Record<string, string> = {};
  try {
    headers = corsHeaders(request);
    const input = z.object({ code: z.string().max(256), verifier: z.string().max(128), clientId: z.string().max(32), redirectURI: z.string().max(200) }).parse(await body(request));
    if (request.headers.get('origin') !== `chrome-extension://${input.clientId}`) throw new HttpError(403, '扩展来源与授权对象不匹配');
    const result = await exchangeAuthorization(input.code, input.verifier, input.clientId, input.redirectURI);
    return Response.json({ ok: true, ...result }, { headers });
  } catch (e) { return failure(e, headers); }
}
