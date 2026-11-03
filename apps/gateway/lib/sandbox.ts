import { Sandbox } from '@vercel/sandbox';

export const sandboxRoot = '/vercel/sandbox/ae-chat';
export function workerEnvironment(): Record<string, string> {
  const secret = process.env.AE_CHAT_GATEWAY_SECRET;
  const encryptionKey = process.env.AE_CHAT_ENCRYPTION_KEY;
  const publicURL = process.env.AE_CHAT_PUBLIC_URL;
  if (!secret || secret.length < 32 || !encryptionKey || encryptionKey.length < 32 || !publicURL) throw new Error('Missing execution environment');
  if (new URL(publicURL).protocol !== 'https:') throw new Error('HTTPS public origin required');
  return {
    NODE_ENV: 'production', HOSTNAME: '0.0.0.0', PORT: '3000',
    AE_CHAT_GATEWAY_SECRET: secret, AE_CHAT_ENCRYPTION_KEY: encryptionKey,
    AE_CHAT_PUBLIC_URL: new URL(publicURL).origin,
    AE_CHAT_SERVER_DATA_DIR: `${sandboxRoot}/data`,
    AE_CHAT_ALLOWED_ORIGINS: process.env.AE_CHAT_ALLOWED_ORIGINS || 'https://api.openai.com',
    AE_CHAT_EXTENSION_IDS: process.env.AE_CHAT_EXTENSION_IDS || '',
    AE_CHAT_STDIO_COMMANDS: process.env.AE_CHAT_STDIO_COMMANDS || '{}'
  };
}

// Sessions restore files, but processes must be started again after every resume.
export async function startWorker(sandbox: Sandbox) {
  await sandbox.runCommand({
    cmd: 'node', args: [`${sandboxRoot}/current/apps/server/server.js`],
    cwd: `${sandboxRoot}/current`, env: workerEnvironment(), detached: true
  });
  const check = await sandbox.runCommand({
    cmd: 'node', env: { AE_CHAT_GATEWAY_SECRET: workerEnvironment().AE_CHAT_GATEWAY_SECRET },
    args: ['-e', `
      (async () => {
        for (let n = 0; n < 100; n++) {
          try { const r = await fetch('http://127.0.0.1:3000/api/health', { headers: { 'x-ae-gateway-secret': process.env.AE_CHAT_GATEWAY_SECRET } }); if (r.ok) return; } catch {}
          await new Promise(r => setTimeout(r, 200));
        }
        process.exit(1);
      })();
    `]
  });
  if (check.exitCode !== 0) throw new Error('Execution service did not start');
}

export async function executionSandbox() {
  workerEnvironment();
  // Creation is an explicit provisioning step, never an anonymous HTTP side effect.
  return Sandbox.get({ name: process.env.AE_CHAT_SANDBOX_NAME || 'chat-chrome-production', resume: true, onResume: startWorker });
}
