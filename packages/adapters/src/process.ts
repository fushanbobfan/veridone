import { spawn } from 'node:child_process';

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
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

export async function runBoundedProcess(request: ProcessRequest): Promise<ProcessResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  const maxOutputBytes = request.maxOutputBytes ?? 512_000;
  const startedAt = performance.now();

  return await new Promise<ProcessResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let state: ProcessResultState = 'completed';
    let settled = false;

    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env ? { ...request.env } : undefined,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const terminateProcessTree = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => child.kill());
        killer.unref();
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
        terminateProcessTree();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      state = 'spawn-error';
      stderr = Buffer.from(error.message);
      finish(null);
    });
    child.on('close', (code) => finish(code));

    const abort = () => {
      if (state !== 'completed') return;
      state = 'cancelled';
      terminateProcessTree();
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();

    const timer = setTimeout(() => {
      if (state !== 'completed') return;
      state = 'timed-out';
      terminateProcessTree();
    }, timeoutMs);
    timer.unref();
  });
}
