import { resolve, join } from 'node:path';
import { executionContext, type ExecutionContext } from '../../../packages/execution-service/context';
export const serverDataDir = () => resolve(process.env.AE_CHAT_SERVER_DATA_DIR || '.server-data');
export function userContext(userId: string): ExecutionContext {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) throw new Error('无效用户 ID');
  const encryptionKey = process.env.AE_CHAT_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) throw new Error('服务端需要至少 32 字符的 AE_CHAT_ENCRYPTION_KEY');
  return {
    userId, dataDir: join(serverDataDir(), 'users', userId), encryptionKey,
    allowedOrigins: (process.env.AE_CHAT_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => new URL(s).origin),
    stdioCommands: JSON.parse(process.env.AE_CHAT_STDIO_COMMANDS || '{}')
  };
}
export function requireContext() { const context = executionContext(); if (!context) throw new Error('缺少已认证的用户上下文'); return context; }
