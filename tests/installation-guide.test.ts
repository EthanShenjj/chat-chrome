import { it, expect, vi } from 'vitest';
import { readInstallationGuide, installationGuideURL } from '../packages/execution-service/installer/guide';

it('reads only the official installation guide and labels its server execution context', async () => {
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('# AE CLI\nUse the installer.', { headers: { 'content-type': 'text/plain' } }));
  try {
    const result = await readInstallationGuide();
    expect(mock).toHaveBeenCalledWith(installationGuideURL, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(result.source).toBe('https://raw.githubusercontent.com/ThinkingAIAgenticEngine/ae-cli/main/cli-installation-guide.md');
    expect(result.text).toContain('Use the installer');
    expect(result.executionTarget).toBe('server-user-workspace');
  } finally { mock.mockRestore(); }
});

it.each([new Response('missing', { status: 404 }), new Response('x'.repeat(65537))])('reports failed or oversized guide downloads', async response => {
  const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  try { await expect(readInstallationGuide()).rejects.toThrow(/指南/); } finally { mock.mockRestore(); }
});
