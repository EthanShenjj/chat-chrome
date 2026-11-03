import { executionSandbox } from '../../lib/sandbox';
import { forward } from '../../lib/forward';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(request: Request) {
  try {
    const sandbox = await executionSandbox();
    return await forward(request, sandbox.domain(3000), process.env.AE_CHAT_GATEWAY_SECRET!);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 503;
    return Response.json({ ok: false, error: status === 413 ? '请求内容过大' : '执行服务暂时不可用，请稍后重试' }, { status, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
  }
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as OPTIONS, handle as HEAD };
