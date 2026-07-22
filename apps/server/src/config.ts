import { homedir } from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  allowedOrigins: string[];
  demoMode: boolean;
}

function defaultDataDirectory(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
      'VeriDone',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'VeriDone');
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
    'veridone',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.VERIDONE_HOST ?? '127.0.0.1';
  const port = Number.parseInt(env.VERIDONE_PORT ?? '4317', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('VERIDONE_PORT must be an integer between 1 and 65535.');
  }
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('VeriDone v1 only supports loopback hosts (127.0.0.1 or ::1).');
  }

  const dataDirectory = path.resolve(env.VERIDONE_DATA_DIR ?? defaultDataDirectory());
  const defaultOrigins = [`http://127.0.0.1:${port}`, 'http://127.0.0.1:4173'];
  const additionalOrigins = (env.VERIDONE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    host,
    port,
    dataDirectory,
    databasePath: path.join(dataDirectory, 'veridone.db'),
    allowedOrigins: [...new Set([...defaultOrigins, ...additionalOrigins])],
    demoMode: env.VERIDONE_DEMO === '1',
  };
}
