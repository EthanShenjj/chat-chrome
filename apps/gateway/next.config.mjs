import { fileURLToPath } from 'node:url';
export default {
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  serverExternalPackages: ['@vercel/sandbox'],
  poweredByHeader: false,
  // The execution server owns its asset hashes; bypass this gateway's Next assets.
  async rewrites() { return { beforeFiles: [{ source: '/_next/:path*', destination: '/__ae_assets/_next/:path*' }] }; }
};
