import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

describe('server configuration', () => {
  it('refuses every non-loopback bind address even when legacy override flags are present', () => {
    expect(() => loadConfig({ VERIDONE_HOST: '0.0.0.0', VERIDONE_ALLOW_REMOTE: '1' })).toThrow(
      'only supports loopback',
    );
    expect(loadConfig({ VERIDONE_HOST: '::1' }).host).toBe('::1');
  });
});
