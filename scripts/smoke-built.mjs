import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a smoke port.');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function terminateTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
      });
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function waitForBuiltWorkspace(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Built process exited with ${child.exitCode}.\n${output()}`);
    }
    try {
      const healthResponse = await fetch(`${url}/api/v1/health`);
      const health = await healthResponse.json();
      const bootstrapResponse = await fetch(`${url}/api/v1/bootstrap`);
      const bootstrap = await bootstrapResponse.json();
      if (healthResponse.ok && health.status === 'ok' && bootstrap.mode === 'local') return;
    } catch {
      // The preview and API processes may not both be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Built workspace did not become healthy.\n${output()}`);
}

const dataDirectory = await mkdtemp(path.join(tmpdir(), 'veridone-built-smoke-'));
const apiPort = await reservePort();
const webPort = await reservePort();
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error('The built smoke must be launched through pnpm.');
let capturedOutput = '';
const child = spawn(process.execPath, [pnpmEntry, 'start'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    VERIDONE_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
    VERIDONE_API_PORT: String(apiPort),
    VERIDONE_DATA_DIR: dataDirectory,
    VERIDONE_PORT: String(apiPort),
    VERIDONE_STRICT_PORT: '1',
    VERIDONE_WEB_PORT: String(webPort),
  },
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const capture = (chunk) => {
  capturedOutput = `${capturedOutput}${chunk}`.slice(-8_000);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

try {
  await waitForBuiltWorkspace(`http://127.0.0.1:${webPort}`, child, () => capturedOutput);
  console.log(`Built workspace smoke passed through preview proxy on ${webPort}/${apiPort}.`);
} finally {
  await terminateTree(child);
  await rm(dataDirectory, { recursive: true, force: true });
}
