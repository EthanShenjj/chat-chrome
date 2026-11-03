import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
const root = await mkdtemp(join(tmpdir(), 'ae-release-smoke-'));
try {
  const name = `ae-chat-agent-${platform()}-${arch()}`;
  execFileSync('tar', ['-xzf', resolve(`release/${name}.tar.gz`), '-C', root]);
  const unpacked = join(root, name), app = join(root, 'installed'), manifests = join(root, 'manifests');
  const output = execFileSync(join(unpacked, 'runtime/node'), [join(unpacked, 'scripts/install-host.mjs'), '--bundled', `--extension-id=${'a'.repeat(32)}`, `--install-dir=${app}`, `--manifest-dir=${manifests}`], { encoding: 'utf8' });
  const manifest = JSON.parse(await readFile(join(manifests, 'com.ae.chat.agent.json'), 'utf8'));
  if (manifest.path !== join(app, 'ae-chat-host') || manifest.allowed_origins[0] !== `chrome-extension://${'a'.repeat(32)}/`) throw new Error('Incorrect native manifest');
  const child = spawn(manifest.path, [], { env: { ...process.env, AE_CHAT_DATA_DIR: join(root, 'data') }, stdio: 'pipe' });
  const reply = await new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0); const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged host did not respond')); }, 10000);
    child.once('error', reject); child.stderr.on('data', data => process.stderr.write(data));
    child.stdout.on('data', data => { bytes = Buffer.concat([bytes, data]); if (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) { clearTimeout(timer); resolve(JSON.parse(bytes.subarray(4, bytes.readUInt32LE(0) + 4).toString('utf8'))); child.stdin.end(); } });
    const body = Buffer.from(JSON.stringify({ id: 'release-test', method: 'ping' })), header = Buffer.alloc(4); header.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([header, body]));
  });
  await new Promise(r => child.once('close', r));
  if (reply.type !== 'result' || Number(reply.result.node.match(/^v(\d+)/)[1]) < 22) throw new Error('Packaged runtime failed');
  console.log(JSON.stringify({ passed: true, nativeHost: reply.result, installation: 'temporary directories only', checks: ['archive extraction', 'bundled runtime', 'bundled npm', 'installer', 'manifest allowlist', 'native messaging ping'] }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
