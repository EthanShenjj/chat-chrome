import { cp, mkdir } from 'node:fs/promises';
const root = 'apps/server/.next/standalone/apps/server';
await mkdir(`${root}/.next`, { recursive: true });
await cp('apps/server/.next/static', `${root}/.next/static`, { recursive: true });
await cp('apps/server/public', `${root}/public`, { recursive: true });
console.log('Prepared self-contained Next.js server (static assets + extension download)');
