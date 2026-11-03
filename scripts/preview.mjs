import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve('dist/extension');
createServer(async (req, res) => { try { const name = new URL(req.url, 'http://localhost').pathname; const path = resolve(root, `.${name === '/' ? '/sidepanel.html' : name}`); if (!path.startsWith(root + '/')) throw new Error(); const data = await readFile(path); res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream'); res.end(data); } catch { res.writeHead(404).end(); } }).listen(4173, '127.0.0.1', () => console.log('UI preview: http://127.0.0.1:4173 (extension actions require Chrome installation)'));
