import { describe, expect, it } from 'vitest';

import { redactSecrets, sanitizeArgsForPacket, sanitizeForPacket } from './redaction.js';

/** Joins a test value from parts, so the repository's secret scan reads no fixture as a leaked credential. */
const joined = (...parts: string[]) => parts.join('');
const beginKey = (kind: string) => joined('-----BEGIN ', kind, 'PRIVATE KEY-----');

describe('secret redaction', () => {
  const cases: Array<[string, string, string]> = [
    ['an assignment', 'password=hunter2', 'password=[REDACTED]'],
    ['a JSON field', '{"password": "hunter 2"}', '{"password": "[REDACTED]"}'],
    ['a single-quoted value', "api_key: 'abc def'", "api_key: '[REDACTED]'"],
    [
      'a quoted value with an escaped quote',
      String.raw`password="a\"still-secret"`,
      'password="[REDACTED]"',
    ],
    [
      'a quoted value cut off before its closing quote',
      'password="cut-off secret',
      'password="[REDACTED]"',
    ],
    [
      'an environment variable',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'AWS_SECRET_ACCESS_KEY=[REDACTED]',
    ],
    ['a token variable', 'export NPM_TOKEN=abc123def456', 'export NPM_TOKEN=[REDACTED]'],
    [
      'an AWS key id',
      joined('AWS_ACCESS_KEY_ID=AKIA', 'IOSFODNN7EXAMPLE'),
      'AWS_ACCESS_KEY_ID=[REDACTED]',
    ],
    [
      'a fine-grained GitHub token',
      joined('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGH'),
      '[REDACTED]',
    ],
    ['a classic GitHub token', joined('ghp_', 'abcdefghijklmnopqrstuvwxyz0123'), '[REDACTED]'],
    [
      'a bearer header',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl',
      'Authorization: Bearer [REDACTED]',
    ],
    ['a Slack token', 'xoxb-1234567890-abcdefghij', '[REDACTED]'],
    [
      'a private key block',
      joined(beginKey('OPENSSH '), '\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----'),
      '[REDACTED PRIVATE KEY]',
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`redacts ${name}`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }

  it('redacts a private key that the output limit cut off', () => {
    expect(redactSecrets(joined('key:\n', beginKey('RSA '), '\nMIIEpAIBAAKCAQEA'))).toBe(
      'key:\n[REDACTED PRIVATE KEY]',
    );
  });

  // Check output comes from the commit under review; a pattern with quadratic cost would stall the server.
  it('stays fast on hostile output', () => {
    for (const hostile of [
      'a-'.repeat(50_000),
      joined(beginKey(''), '\n').repeat(10_000),
      'password: "'.repeat(20_000),
    ]) {
      const started = performance.now();
      sanitizeForPacket(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  for (const prose of [
    'max_tokens = 4096',
    'token_count: 12',
    'the secret is out',
    'Bearer tokens expire',
    'Basic authentication is off',
    'See https://example.com/docs/api_key for details.',
  ]) {
    it(`leaves "${prose}" alone`, () => {
      expect(redactSecrets(prose)).toBe(prose);
    });
  }
});

describe('packet sanitizing', () => {
  const paths: Array<[string, string]> = [
    ['a Windows path', String.raw`C:\Users\bob\work\client\notes.md`],
    ['a Windows path with forward slashes', 'C:/Users/bob/work/client/notes.md'],
    ['a UNC path', String.raw`\\fileserver\share\clients\acme\notes.md`],
    ['a mounted volume', '/mnt/data/clients/acme/notes.md'],
    ['a macOS volume', '/Volumes/Backup/clients/acme'],
    ['a server path', '/srv/clients/acme/report.txt'],
    ['a root home path', '/root/.ssh/config'],
    ['a home-relative path', '~/clients/acme/notes.md'],
    ['a Windows path with spaces', String.raw`C:\Users\Bob Smith\client acme\notes.md`],
    ['a Windows path escaped in JSON', String.raw`C:\\Users\\Alice\\client-private\\file.txt`],
    ['a UNC path escaped in JSON', String.raw`\\\\fileserver\\share\\clients\\acme`],
    ['a home path with spaces', '/home/bob smith/client acme/notes.md'],
    ['a home-relative path with spaces', '~/client acme/notes.md'],
  ];
  for (const [name, input] of paths) {
    it(`replaces ${name}`, () => {
      expect(sanitizeForPacket(`see ${input} here`)).toBe('see [LOCAL_PATH] here');
    });
  }

  it('replaces a path inside JSON text up to its closing quote', () => {
    const text = JSON.stringify({ path: String.raw`C:\Users\Alice\client-private\file.txt` });
    expect(sanitizeForPacket(text)).toBe('{"path":"[LOCAL_PATH]"}');
  });

  it('stays fast on hostile paths', () => {
    for (const hostile of [
      `C:\\${'a '.repeat(50_000)}`,
      `C:${'\\'.repeat(50_000)}x`,
      `${'C:\\a '.repeat(20_000)}`,
      `/home/${'a '.repeat(50_000)}`,
      `\\\\${'a\\'.repeat(50_000)} b`,
      `~/${'a b/'.repeat(30_000)}`,
    ]) {
      const started = performance.now();
      sanitizeForPacket(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('keeps URLs and repository-relative paths', () => {
    const text = 'Fixed src/app.ts as https://example.com/issues/3 describes.';
    expect(sanitizeForPacket(text)).toBe(text);
  });

  it('redacts secrets as well as paths', () => {
    expect(sanitizeForPacket('token=abc123 in /home/bob/x')).toBe(
      'token=[REDACTED] in [LOCAL_PATH]',
    );
  });
});

describe('packet arguments', () => {
  it('redacts the value that follows an option named for a secret', () => {
    expect(
      sanitizeArgsForPacket(['--token', 'opaque-value', '--client-secret', 'other', '-v']),
    ).toEqual(['--token', '[REDACTED]', '--client-secret', '[REDACTED]', '-v']);
  });

  it('applies the text rules to every other argument', () => {
    expect(
      sanitizeArgsForPacket([
        '--max-tokens',
        '4096',
        '--test',
        String.raw`C:\Users\bob\client\x.test.mjs`,
        '--token=abc123',
      ]),
    ).toEqual(['--max-tokens', '4096', '--test', '[LOCAL_PATH]', '--token=[REDACTED]']);
  });
});
