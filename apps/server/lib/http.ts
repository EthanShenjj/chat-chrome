import { z } from 'zod';
import { errorText } from '../../../packages/contracts/index';
import { authenticate, corsHeaders, HttpError } from './auth';
import { userContext } from './environment';
import { getWorkspace } from './workspace';
export const RPC_LIMIT = 2 * 1024 * 1024;
async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
  if (Number(request.headers.get('content-length')) > RPC_LIMIT) throw new HttpError(413, '请求内容过大');
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, '请求内容为空');
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > RPC_LIMIT) { await reader.cancel(); throw new HttpError(413, '请求内容过大'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON 格式无效'); }
}
export function options(request: Request) { try { return new Response(null, { status: 204, headers: corsHeaders(request) }); } catch (e) { return failure(e); } }
function failure(error: unknown, headers: Record<string, string> = {}) {
  const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 400;
  const message = error instanceof z.ZodError ? '参数格式无效，请检查输入内容' : errorText(error);
  return Response.json({ ok: false, error: message }, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
}
export async function rpc(request: Request) {
  let headers: Record<string, string> = {};
  try {
    headers = corsHeaders(request); const user = await authenticate(request);
    const message = await readBody(request); z.object({ type: z.string().max(80) }).parse(message);
    const workspace = await getWorkspace(userContext(user.id));
    const result = await workspace.dispatch(message);
    if (result?.session) result.auth = { status: 'authenticated', userId: user.id };
    return Response.json({ ok: true, result }, { headers });
  } catch (error) { return failure(error, headers); }
}
export async function events(request: Request) {
  let headers: Record<string, string> = {};
  try {
    headers = corsHeaders(request); const user = await authenticate(request); const workspace = await getWorkspace(userContext(user.id));
    let cleanup = () => {};
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false, reading = false, previous = '', ticks = 0;
        const close = () => { if (closed) return; closed = true; clearInterval(timer); clearTimeout(expiry); request.signal.removeEventListener('abort', close); try { controller.close(); } catch {} };
        cleanup = close;
        const send = async () => {
          if (closed || reading) return; reading = true;
          try {
            ticks++; await authenticate(request, false);
            const json = JSON.stringify({ ...await workspace.snapshot(), auth: { status: 'authenticated', userId: user.id } });
            if (closed) return;
            if (json !== previous) { controller.enqueue(encoder.encode(`event: state\ndata: ${json}\n\n`)); previous = json; }
            else if (ticks % 10 === 0) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          } catch { close(); } finally { reading = false; }
        };
        const timer = setInterval(() => void send(), 750), expiry = setTimeout(close, 55000);
        request.signal.addEventListener('abort', close, { once: true }); if (request.signal.aborted) close(); else void send();
      },
      cancel() { cleanup(); }
    });
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' } });
  } catch (error) { return failure(error, headers); }
}
