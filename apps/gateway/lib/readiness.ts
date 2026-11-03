export async function waitForWorker(origin: string, secret: string, interval = 250) {
  const deadline = Date.now() + 25000;
  do {
    try {
      const response = await fetch(`${origin}/api/health`, {
        headers: { 'x-ae-gateway-secret': secret }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000)
      });
      if (response.ok) { await response.body?.cancel(); return; }
      await response.body?.cancel();
    } catch { /* The restored VM's public port can lag behind its local listener. */ }
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  throw new Error('Execution service is still resuming');
}
