import { afterEach, expect, test, vi } from 'vitest';
import { forward } from '../apps/gateway/lib/forward';
import { waitForWorker } from '../apps/gateway/lib/readiness';

afterEach(() => vi.unstubAllGlobals());
test('forwards sessions and authorization while replacing gateway and host headers', async () => {
  const fetcher = vi.fn(async (_url, options) => {
    expect(options.headers.get('cookie')).toBe('ae_session=example');
    expect(options.headers.get('authorization')).toBe('Bearer example');
    expect(options.headers.get('x-ae-gateway-secret')).toBe('actual-secret');
    expect(options.headers.has('host')).toBe(false);
    expect(options.headers.has('x-forwarded-host')).toBe(false);
    expect(options.redirect).toBe('manual');
    return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': 'ae_session=new; HttpOnly; Secure' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const response = await forward(new Request('https://chat.example/workspace', { headers: { cookie: 'ae_session=example', authorization: 'Bearer example', host: 'attacker', 'x-forwarded-host': 'attacker', 'x-ae-gateway-secret': 'spoofed' } }), 'https://sandbox.example', 'actual-secret');
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('https://chat.example/login');
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure');
});
test('streams events without waiting for the upstream stream to close', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } }));
  const response = await forward(new Request('https://chat.example/api/events'), 'https://sandbox.example', 'secret');
  const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
  expect(response.headers.has('content-encoding')).toBe(false);
  controller.close();
});
test('rejects oversized uploads before forwarding to the execution service', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(forward(new Request('https://chat.example/api/rpc', { method: 'POST', body: 'a'.repeat(2 * 1024 * 1024 + 1) }), 'https://sandbox.example', 'secret')).rejects.toThrow(RangeError);
  expect(fetcher).not.toHaveBeenCalled();
});
test('waits for the restored public port using protected read-only health probes', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('restoring', { status: 502 })).mockResolvedValueOnce(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetcher);
  await waitForWorker('https://sandbox.example', 'actual-secret', 1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).toBe('https://sandbox.example/api/health');
    expect(options.headers['x-ae-gateway-secret']).toBe('actual-secret');
    expect(options.body).toBeUndefined();
  }
});
test('does not replay a user write if the upstream responds with a gateway error', async () => {
  const fetcher = vi.fn(async () => new Response('unavailable', { status: 502 })); vi.stubGlobal('fetch', fetcher);
  const response = await forward(new Request('https://chat.example/api/rpc', { method: 'POST', body: '{"type":"chat.send"}' }), 'https://sandbox.example', 'secret');
  expect(response.status).toBe(502);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
