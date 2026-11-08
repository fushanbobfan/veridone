import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * False starts the process with no console on Windows. Otherwise it gets a hidden console of its own, and Windows
   * starts a console host process for it as soon as the program touches that console.
   */
  console?: boolean;
}

export type ProcessResultState =
  'completed' | 'timed-out' | 'cancelled' | 'spawn-error' | 'output-capped';

export interface ProcessResult {
  state: ProcessResultState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// taskkill reads the process tree through WMI, and on a busy machine Windows has cancelled such queries in bursts of up
// to about 3 s. A failed try is repeated after each of these waits, then child.kill() goes to the direct child alone.
const treeKillRetryDelaysMs = [1_000, 2_000];
// A taskkill try still running after this long counts as failed; with about a thousand processes running, one took 3 to
// 4 s to succeed.
const treeKillTryLimitMs = 10_000;
// A process that outlives the kill can keep the output pipes open, so the run settles at most this long after the kill.
const pipeCloseGraceMs = 2_000;

/** Runs `taskkill /t /f` on a process tree and resolves whether it reported success within its time limit. */
function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Node emits 'error' when the file is missing or inaccessible or resources run short, and throws for any other
      // failure.
      resolve(false);
      return;
    }
    const done = (succeeded: boolean) => {
      clearTimeout(limit);
      resolve(succeeded);
    };
    // The try ends at its limit whether or not the kill of taskkill brings its close event.
    const limit = setTimeout(() => {
      done(false);
      killer.kill();
    }, treeKillTryLimitMs);
    limit.unref();
    killer.once('error', () => done(false));
    killer.once('close', (code) => done(code === 0));
    killer.unref();
  });
}

export async function runBoundedProcess(request: ProcessRequest): Promise<ProcessResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  const maxOutputBytes = request.maxOutputBytes ?? 512_000;
  const startedAt = performance.now();

  return await new Promise<ProcessResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let state: ProcessResultState = 'completed';
    let settled = false;
    let pipeTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env ? { ...request.env } : undefined,
      // Detached is a process group elsewhere; on Windows it is DETACHED_PROCESS, a process with no console.
      detached: process.platform !== 'win32' || request.console === false,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Once Node has seen the direct child exit, its pid can belong to another process.
    const childRunning = () => child.exitCode === null && child.signalCode === null;

    const terminateProcessTree = async () => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === 'win32') {
        for (let attempt = 0; childRunning(); attempt += 1) {
          if (await taskkillTree(pid)) break;
          const wait = treeKillRetryDelaysMs[attempt];
          if (wait === undefined) {
            if (childRunning()) child.kill();
            break;
          }
          await delay(wait, undefined, { ref: false });
        }
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      if (settled) return;
      pipeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode);
      }, pipeCloseGraceMs);
      pipeTimer.unref();
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pipeTimer);
      request.signal?.removeEventListener('abort', abort);
      resolve({
        state,
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const totalLength = stdout.length + stderr.length;
      const remaining = Math.max(0, maxOutputBytes - totalLength);
      const accepted = chunk.subarray(0, remaining);
      if (target === 'stdout') stdout = Buffer.concat([stdout, accepted]);
      else stderr = Buffer.concat([stderr, accepted]);

      if (accepted.length < chunk.length && state === 'completed') {
        state = 'output-capped';
        void terminateProcessTree();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      // A failed kill arrives here too; the run keeps its state and settles after the kill.
      if ((error as NodeJS.ErrnoException).syscall === 'kill') return;
      state = 'spawn-error';
      stderr = Buffer.from(error.message);
      finish(null);
    });
    child.on('close', (code) => finish(code));

    const abort = () => {
      if (state !== 'completed') return;
      state = 'cancelled';
      void terminateProcessTree();
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();

    const timer = setTimeout(() => {
      if (state !== 'completed') return;
      state = 'timed-out';
      void terminateProcessTree();
    }, timeoutMs);
    timer.unref();
  });
}
