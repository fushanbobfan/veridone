import { describe, expect, it } from 'vitest';

import { allowedHosts, loadConfig } from './config.js';

describe('server configuration', () => {
  it('allows the Host values of its own loopback names and of each allowed origin', () => {
    const config = loadConfig({
      VERIDONE_PORT: '4418',
      VERIDONE_ALLOWED_ORIGINS: 'http://127.0.0.1:4417',
    });
    expect(allowedHosts(config).sort()).toEqual(
      ['127.0.0.1:4418', 'localhost:4418', '[::1]:4418', '127.0.0.1:4173', '127.0.0.1:4417'].sort(),
    );
  });

  it('refuses every non-loopback bind address even when legacy override flags are present', () => {
    expect(() => loadConfig({ VERIDONE_HOST: '0.0.0.0', VERIDONE_ALLOW_REMOTE: '1' })).toThrow(
      'only supports loopback',
    );
    expect(loadConfig({ VERIDONE_HOST: '::1' }).host).toBe('::1');
  });
});
