import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2), destination = args[args.indexOf('--prefix') + 1];
const version = args.at(-1).split('@').at(-1);
await mkdir(join(destination, 'node_modules/.bin'), { recursive: true });
await writeFile(join(destination, 'node_modules/.bin/ae-cli'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
await writeFile(join(destination, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@thinkingai/ae-cli': { integrity: 'sha512-fixture-integrity' } } }));
