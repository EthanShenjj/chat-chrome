import { it, expect, vi } from 'vitest';
import { AuthenticationError, CloudBridge } from '../apps/extension/background/cloud';
it('discards a late authentication error after the extension switched accounts', async () => {
  let complete!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(r => { complete = r; }));
  const onError = vi.fn(), bridge = new CloudBridge({ url: 'https://agent.example.com', token: 'a'.repeat(43) }, () => {}, onError);
  try { const pending = bridge.request('state.get'); bridge.configure({ url: 'https://agent.example.com', token: 'b'.repeat(43) }); complete(Response.json({ error: 'expired old account' }, { status: 401 })); await expect(pending).rejects.toThrow('身份已变化'); expect(onError).not.toHaveBeenCalled(); } finally { bridge.close(); fetch.mockRestore(); }
});
it('blocks an expired session without replaying a write request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'expired' }, { status: 401 }));
  const onError = vi.fn(), bridge = new CloudBridge({ url: 'https://agent.example.com', token: 'a'.repeat(43) }, () => {}, onError);
  try { await expect(bridge.request('chat.send', { text: 'create' })).rejects.toBeInstanceOf(AuthenticationError); expect(fetch).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalledWith(expect.any(String), true); } finally { bridge.close(); fetch.mockRestore(); }
});
