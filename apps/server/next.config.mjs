import { fileURLToPath } from 'node:url';
/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  serverExternalPackages: ['@openai/agents', '@openai/agents-core', '@openai/agents-openai', '@modelcontextprotocol/sdk', 'openai', 'ajv'],
  poweredByHeader: false,
  async headers() { return [{ source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] }]; }
};
