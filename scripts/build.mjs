import { build, context } from 'esbuild';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('dist/extension', { recursive: true });
await mkdir('dist/native-host', { recursive: true });
await copyFile('apps/extension/manifest.json', 'dist/extension/manifest.json');
for (const page of ['sidepanel', 'options']) {
  await writeFile(`dist/extension/${page}.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AE Chat Agent${page === 'options' ? ' · 设置' : ''}</title><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script type="module" src="ui.js"></script></body></html>`);
}
const configs = [
  { entryPoints: { ui: 'apps/extension/sidepanel/main.tsx', background: 'apps/extension/background/index.ts' }, outdir: 'dist/extension', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', define: { 'process.env.NODE_ENV': '"production"' } },
  { entryPoints: ['apps/extension/content/index.ts'], outfile: 'dist/extension/content.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120' }
];
if (process.argv.includes('--legacy-native')) configs.push({ entryPoints: ['apps/native-host/index.ts'], outfile: 'dist/native-host/host.cjs', bundle: true, format: 'cjs', platform: 'node', target: 'node20', packages: 'bundle', external: ['electron'] });
if (process.argv.includes('--watch')) {
  for (const config of configs) await (await context(config)).watch();
  console.log('Watching extension…');
} else {
  for (const config of configs) await build(config);
  await mkdir('apps/server/public', { recursive: true });
  await rm('apps/server/public/ae-chat-extension.zip', { force: true });
  execFileSync('zip', ['-q', '-r', '../../apps/server/public/ae-chat-extension.zip', '.'], { cwd: 'dist/extension' });
  console.log('Built dist/extension and apps/server/public/ae-chat-extension.zip');
}
