// Shared helpers for the release walks: check what a walk needs, prepare the clones it walks, start a built VeriDone,
// call its API, and report each check. README.md beside this file says what each walk needs and where it runs.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

/** The clone these scripts live in. */
export const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

/** The release whose real build the upgrade and dead-end walks start from. */
export const previousRelease = 'v1.1.0';

// pytest prints a summary the packet can read, `src` makes the package importable from a checkout that has no
// install, and the cache plugin would leave an unignored directory behind.
export const checkArgs = ['-m', 'pytest', '-q', '-o', 'pythonpath=src', '-p', 'no:cacheprovider'];

// The commits the walks were last checked on. An operator's clone sits on its default branch, so the walks do too.
const publicRepositoryCommits = {
  'ai-eval-micro-lab': 'b44a7fad14bc5dbd60e7cda864567bdc4418e3c2',
  'useful-automation-lab': '17f98eda7573b2eaacb1804f9809fbdefb531677',
};

// A walk runs for minutes beside whatever else the machine is doing; child processes inherit this.
os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);

/** A prerequisite is missing, so the walk says what to do and reaches no verdict on the app. */
export class CannotStart extends Error {}

const results = [];
const services = new Set();

export function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  return Boolean(ok);
}

export async function stopServices() {
  await Promise.all([...services].map((service) => service.stop()));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // Nothing waits for them after this, so they end by force.
    for (const service of services) service.kill('SIGKILL');
    process.exit(130);
  });
}

/** Runs a walk and prints its verdict. The exit code is 0 for a pass, 1 for a fail, and 2 when it could not start. */
export async function runWalk(label, body) {
  try {
    await body();
  } catch (error) {
    if (error instanceof CannotStart) {
      console.error(`${label}: COULD NOT START\n${error.message}`);
      await stopServices();
      process.exit(2);
    }
    check('the walk ran to its end', false, String(error?.message ?? error).slice(0, 800));
  }
  await stopServices();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  for (const result of failed) console.log(`  failed: ${result.name}`);
  console.log(failed.length === 0 ? `${label}: PASS` : `${label}: FAIL`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/** Reads `--root` and `--ref`. The root holds everything a walk writes and defaults to the ignored output folder. */
export async function walkOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2).filter((argument) => argument !== '--'),
      options: { root: { type: 'string' }, ref: { type: 'string' } },
    }));
  } catch (error) {
    throw new CannotStart(`${error.message}\nThe options are --root DIR and --ref REF.`);
  }
  if (!process.env.npm_execpath)
    throw new CannotStart('Start this through pnpm, as README.md shows.');
  const root = path.resolve(values.root ?? path.join(repositoryRoot, 'output', 'walks'));
  await mkdir(root, { recursive: true });
  // The workspace records canonical paths, and a folder can sit behind an alias.
  return { root: await realpath(root), ref: values.ref };
}

export async function git(repository, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    windowsHide: true,
  });
  return stdout.trim();
}

/** Runs a pnpm command with the pnpm that started this script, writing its output to a file, and gives its exit code. */
export async function pnpmToLog(cwd, args, logFile) {
  await mkdir(path.dirname(logFile), { recursive: true });
  const log = await open(logFile, 'w');
  try {
    const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
      cwd,
      stdio: ['ignore', log.fd, log.fd],
      windowsHide: true,
    });
    const [code] = await once(child, 'exit');
    return code ?? 1;
  } finally {
    await log.close();
  }
}

async function commitOf(ref) {
  const known = await git(
    repositoryRoot,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ).catch(() => '');
  if (known) return known;
  // A shallow clone has no tags, and origin hands over a commit on no branch only for its full hash.
  try {
    await git(repositoryRoot, 'fetch', '--quiet', '--no-tags', 'origin', ref);
    return await git(repositoryRoot, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
  } catch (error) {
    throw new CannotStart(
      `${ref} is neither in this clone nor on origin. Name a commit by its full hash.\n${error.message}`,
    );
  }
}

/** Whether a clone an earlier walk prepared still holds its commit, unchanged, with its builds. */
async function stillPrepared(directory, commit) {
  try {
    await access(path.join(directory, 'apps', 'server', 'dist', 'index.js'));
    await access(path.join(directory, 'apps', 'web', 'dist', 'index.html'));
    return (
      (await git(directory, 'rev-parse', 'HEAD')) === commit &&
      (await git(directory, 'status', '--porcelain')) === ''
    );
  } catch {
    return false;
  }
}

/**
 * A clone of `ref` with a frozen install and a build. It stays under the root for the next walk until it changes or
 * Node's native module version does; `reuse: false` makes a new one.
 */
export async function preparedClone(root, ref, { reuse = true } = {}) {
  const commit = await commitOf(ref);
  const directory = path.join(root, 'clones', commit.slice(0, 12));
  const stamp = `${directory}.ready`;
  const platform = `${process.platform} ${process.arch} ${process.versions.modules}`;
  if (
    reuse &&
    (await readFile(stamp, 'utf8').catch(() => '')) === platform &&
    (await stillPrepared(directory, commit))
  ) {
    return directory;
  }
  await rm(stamp, { force: true });
  await fresh(directory);
  console.log(`--- preparing ${ref} at ${commit.slice(0, 12)} in ${directory}`);
  await git(root, 'clone', '--quiet', '--no-checkout', repositoryRoot, directory);
  // A local clone leaves a commit on no branch behind when the source is shallow.
  await git(directory, 'fetch', '--quiet', repositoryRoot, commit);
  await git(directory, 'checkout', '--quiet', '--detach', commit);
  for (const [step, args] of [
    ['install', ['install', '--frozen-lockfile']],
    ['build', ['build']],
  ]) {
    const logFile = `${directory}-${step}.log`;
    console.log(`    ${step} started at ${new Date().toLocaleTimeString()}; output in ${logFile}`);
    const code = await pnpmToLog(directory, args, logFile);
    if (code !== 0) {
      throw new CannotStart(`The ${step} of ${ref} ended with exit code ${code}. See ${logFile}.`);
    }
  }
  await writeFile(stamp, platform);
  return directory;
}

/**
 * The tree to walk: a clone of `ref` when one is named, or else this clone. This clone is built first, since a walk of
 * a stale build proves nothing about the code in front of the reader.
 */
export async function cloneUnderTest(root, ref) {
  let clone = repositoryRoot;
  if (ref) {
    clone = await preparedClone(root, ref);
  } else {
    const logFile = path.join(root, 'build.log');
    console.log(`--- building this clone; output in ${logFile}`);
    const code = await pnpmToLog(repositoryRoot, ['build'], logFile);
    if (code !== 0) {
      throw new CannotStart(
        `pnpm build ended with exit code ${code}. See ${logFile}. A fresh clone needs pnpm install --frozen-lockfile first.`,
      );
    }
  }
  const changes =
    (await git(clone, 'status', '--porcelain')) === '' ? '' : ' with uncommitted changes';
  console.log(`--- clone under test at ${await git(clone, 'rev-parse', 'HEAD')}${changes}`);
  return clone;
}

// The variables VeriDone passes to a check, from minimalEnvironment in apps/server/src/check-runner.ts.
function checkEnvironment() {
  const names =
    process.platform === 'win32'
      ? ['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATH', 'PATHEXT']
      : ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'];
  return Object.fromEntries(
    names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
}

/**
 * The Python a check can pin: VeriDone pins the file a link leads to and passes few variables, so pytest has to import
 * from that file under those variables, away from any pytest.py where the walk was started. ai-eval-micro-lab has a
 * test that fails before Python 3.12, where sum() rounds floats differently, whatever VeriDone does.
 */
export async function findPython() {
  const problems = [];
  for (const command of ['python', 'python3']) {
    try {
      const { stdout } = await execFileAsync(
        command,
        ['-c', 'import sys; print(sys.executable); print(sys.version_info[:2] >= (3, 12))'],
        { windowsHide: true },
      );
      const [found, recent] = stdout.trim().split(/\r?\n/u);
      if (recent !== 'True') throw new Error(`${found} is older than Python 3.12.`);
      const executable = await realpath(found);
      await execFileAsync(executable, ['-c', 'import pytest'], {
        cwd: os.tmpdir(),
        env: checkEnvironment(),
        windowsHide: true,
      });
      return executable;
    } catch (error) {
      const reason = String(error.stderr || error.message).trim();
      problems.push(`${command}: ${reason.split('\n').at(-1)}`);
    }
  }
  throw new CannotStart(
    `This walk needs Python 3.12 or newer with pytest installed in that interpreter: python -m pip install pytest\n${problems.join('\n')}`,
  );
}

export async function launchChromium() {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    throw new CannotStart('This walk needs the dependencies: pnpm install --frozen-lockfile');
  }
  try {
    return await chromium.launch();
  } catch (error) {
    throw new CannotStart(
      `This walk needs Playwright's Chromium: pnpm exec playwright install chromium\n${error.message}`,
    );
  }
}

/** Clones a public repository a walk reviews into `parent`, from GitHub, and gives its path. */
export async function clonePublicRepository(parent, name) {
  const directory = path.join(parent, name);
  try {
    await git(parent, 'clone', '--quiet', `https://github.com/fushanbobfan/${name}.git`, directory);
    await git(directory, 'reset', '--quiet', '--hard', publicRepositoryCommits[name]);
  } catch (error) {
    throw new CannotStart(`This walk clones ${name} from GitHub, which failed.\n${error.message}`);
  }
  return directory;
}

export async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Waits until nothing listens on the ports, so a restart on the same ports can bind them. */
export async function waitForFreePorts(ports) {
  const isFree = (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(ports.map(isFree))).every(Boolean)) return;
    await delay(200);
  }
  throw new Error(`Ports ${ports.join(', ')} stayed in use for 30 seconds.`);
}

/**
 * Starts a long-running Node process. With `tree` it can start children of its own, and stopping it ends them too:
 * through taskkill on Windows, and through its own process group elsewhere.
 */
export function startService(args, { cwd, env = {}, tree = false }) {
  const groupOwner = tree && process.platform !== 'win32';
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: groupOwner,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-4_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const running = () => child.exitCode === null && child.signalCode === null;
  // The group can outlive the process that started it, and signal 0 only asks whether anything is left in it.
  const groupAlive = () => {
    if (!groupOwner) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const service = {
    output: () => output,
    running,
    kill: (signal) => {
      try {
        if (groupOwner) {
          process.kill(-child.pid, signal);
        } else if (running() && tree) {
          execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else if (running()) {
          child.kill(signal);
        }
      } catch {
        // The group is empty, or taskkill found no such tree.
        child.kill('SIGKILL');
      }
    },
    stop: async () => {
      services.delete(service);
      const exited = running() ? once(child, 'exit') : null;
      service.kill('SIGTERM');
      const deadline = Date.now() + 15_000;
      while ((running() || groupAlive()) && Date.now() < deadline) await delay(100);
      if (running() || groupAlive()) service.kill('SIGKILL');
      if (exited) await exited;
    },
  };
  services.add(service);
  return service;
}

/** Starts the built API server of a clone on a data directory. */
export async function startApi(clone, dataDir, extraEnv = {}) {
  const port = await reservePort();
  await mkdir(dataDir, { recursive: true });
  const service = startService(['dist/index.js'], {
    cwd: path.join(clone, 'apps', 'server'),
    env: {
      VERIDONE_DATA_DIR: dataDir,
      VERIDONE_PORT: String(port),
      VERIDONE_ALLOWED_ORIGINS: 'http://127.0.0.1:1',
      ...extraEnv,
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let health = null;
  while (Date.now() < deadline && service.running()) {
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Not listening yet.
    }
    await delay(200);
  }
  return { base, health, output: service.output, stop: service.stop };
}

/** Calls an API the way the web client does, with the anti-CSRF token from the bootstrap. */
export function client(base) {
  let token = null;
  const call = async (method, route, body) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token && method !== 'GET') headers['X-VeriDone-CSRF'] = token;
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Packets in other formats and PEM files are text.
    }
    return { status: response.status, json, text, headers: response.headers };
  };
  return {
    boot: async () => {
      const result = await call('GET', '/api/v1/bootstrap');
      token = result.json?.csrfToken ?? token;
      return result.json;
    },
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
  };
}

export async function verifyPacket(clone, packetFile, keyFile) {
  const args = [
    process.env.npm_execpath,
    '--silent',
    'verify:packet',
    packetFile,
    ...(keyFile ? ['--key', keyFile] : []),
  ];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: clone,
      windowsHide: true,
    });
    return { code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
  }
}

export async function writeReceipt(file, runId) {
  await writeFile(
    file,
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      started_at: '2026-11-05T09:00:00-08:00',
      completed_at: '2026-11-05T09:05:00-08:00',
      status: 'complete',
      task: { type: 'implementation' },
      stages: [{ name: 'tests', status: 'completed', output: 'the claim stays untrusted' }],
    }),
  );
}

export async function fresh(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(directory, { recursive: true });
}
