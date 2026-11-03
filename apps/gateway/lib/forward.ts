const hopHeaders = ['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'];
const maxBody = 2 * 1024 * 1024;

async function requestBody(request: Request) {
  if (Number(request.headers.get('content-length')) > maxBody) throw new RangeError('Request too large');
  if (!request.body) return undefined;
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > maxBody) { await reader.cancel(); throw new RangeError('Request too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function forward(request: Request, backend: string, secret: string) {
  const source = new URL(request.url), target = new URL(backend);
  target.pathname = source.pathname.replace(/^\/__ae_assets(?=\/_next\/)/, ''); target.search = source.search;
  const headers = new Headers(request.headers);
  for (const key of hopHeaders) headers.delete(key);
  headers.set('x-ae-gateway-secret', secret);
  headers.delete('x-forwarded-host'); headers.delete('x-forwarded-proto');
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await requestBody(request);
  const upstream = await fetch(target, { method: request.method, headers, body, redirect: 'manual', cache: 'no-store', signal: request.signal });
  const output = new Headers(upstream.headers);
  for (const key of hopHeaders) output.delete(key);
  // fetch decompresses responses, so upstream compression metadata is no longer valid.
  output.delete('content-encoding');
  output.set('Cache-Control', 'no-store'); output.set('X-Content-Type-Options', 'nosniff');
  const location = output.get('location');
  if (location) { const redirect = new URL(location, target); if (redirect.origin === target.origin) output.set('location', `${source.origin}${redirect.pathname}${redirect.search}${redirect.hash}`); }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: output });
}
