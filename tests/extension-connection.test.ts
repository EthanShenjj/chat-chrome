import { afterEach, expect, test, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
test('explains a missing extension receiver without replaying a write', async () => {
  const sendMessage = vi.fn().mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
  vi.stubGlobal('chrome', { runtime: { id: 'example', sendMessage } });
  vi.stubGlobal('location', { protocol: 'chrome-extension:', pathname: '/options.html' });
  const { request } = await import('../apps/extension/sidepanel/api');
  await expect(request('chat.send', { text: 'hello' })).rejects.toThrow('重新加载扩展');
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
