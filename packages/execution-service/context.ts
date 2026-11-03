import { AsyncLocalStorage } from 'node:async_hooks';
export interface ExecutionContext {
  userId: string;
  dataDir: string;
  encryptionKey: string;
  allowedOrigins: string[];
  stdioCommands: Record<string, { command: string; args: string[] }>;
}
const execution = new AsyncLocalStorage<ExecutionContext>();
export const executionContext = () => execution.getStore();
export const withExecutionContext = <T>(context: ExecutionContext, fn: () => T): T => execution.run(context, fn);
export function assertAllowedOrigin(value: string) {
  const context = executionContext();
  if (context && !context.allowedOrigins.includes(new URL(value).origin)) throw new Error('目标域名尚未由服务管理员授权');
}
export function childEnvironment(): NodeJS.ProcessEnv {
  const context = executionContext();
  if (!context) return { ...process.env, NO_COLOR: '1' };
  return { NODE_ENV: 'production', PATH: process.env.PATH ?? '', HOME: context.dataDir, XDG_CONFIG_HOME: `${context.dataDir}/.config`, TMPDIR: `${context.dataDir}/tmp`, LANG: 'C.UTF-8', NO_COLOR: '1' };
}
