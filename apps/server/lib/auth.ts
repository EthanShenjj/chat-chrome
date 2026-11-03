import { HttpError, loadUsers, equalHash, rateLimitUser, tokenHash, type UserRecord } from './auth-records';
import { cookieToken, webSession, extensionUser } from './sessions';
export { HttpError, tokenHash, rateLimitUser, type UserRecord } from './auth-records';
export function requestOrigin(request: Request) {
  if (process.env.AE_CHAT_PUBLIC_URL) return new URL(process.env.AE_CHAT_PUBLIC_URL).origin;
  const url = new URL(request.url), host = request.headers.get('host');
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  return host ? new URL(`${['http', 'https'].includes(forwardedProtocol ?? '') ? forwardedProtocol + ':' : url.protocol}//${host}`).origin : url.origin;
}
export function sameOrigin(request: Request) {
  if (request.headers.get('origin') !== requestOrigin(request)) throw new HttpError(403, '请在服务网页中完成此操作');
}
export async function authenticate(request: Request, limit = true): Promise<UserRecord> {
  const authorization = request.headers.get('authorization'); let user: UserRecord | undefined;
  if (authorization) {
    const token = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
    if (!token) throw new HttpError(401, '请先登录服务网页');
    if (token.startsWith('ae_ext_')) user = await extensionUser(token);
    else if (process.env.AE_CHAT_ALLOW_LEGACY_TOKENS === 'true') user = (await loadUsers()).find(u => !u.disabled && equalHash(tokenHash(token), u.tokenHash));
  } else {
    if (!['GET', 'HEAD'].includes(request.method)) sameOrigin(request);
    user = (await webSession(cookieToken(request))).user;
  }
  if (!user) throw new HttpError(401, '登录已失效，请重新登录服务网页');
  if (limit) rateLimitUser(user.id); return user;
}
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowedExtensions = (process.env.AE_CHAT_EXTENSION_IDS || '').split(',').filter(Boolean).map(id => `chrome-extension://${id.trim()}`);
  if (origin && origin !== requestOrigin(request) && !allowedExtensions.includes(origin)) throw new HttpError(403, '此扩展来源尚未由管理员授权');
  return { ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
}
