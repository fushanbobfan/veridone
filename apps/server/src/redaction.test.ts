import { describe, expect, it } from 'vitest';

import {
  createPacketSanitizer,
  redactSecrets,
  sanitizeArgsForPacket,
  sanitizeForPacket,
} from './redaction.js';

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
      'a quoted value continued past a line break',
      'password="a\\\nstill-secret"',
      'password="[REDACTED]"',
    ],
    [
      'a quoted value continued past a Windows line break',
      'password="a\\\r\nstill-secret"',
      'password="[REDACTED]"',
    ],
    ['a value with a shell-escaped space', 'password=alpha\\ beta', 'password=[REDACTED]'],
    ['a value made of adjacent quoted parts', `password='alpha'"beta"`, "password='[REDACTED]'"],
    ['an unquoted value holding a closing brace', 'password=alpha}bravo', 'password=[REDACTED]'],
    [
      'a quoted value followed by a shell operator',
      `password='alpha'&&echo ready`,
      `password='[REDACTED]'&&echo ready`,
    ],
    ['a quoted value piped on', `password='alpha'|wc -c`, `password='[REDACTED]'|wc -c`],
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

  it('replaces a quoted path whose last part holds a space', () => {
    expect(
      sanitizeForPacket(JSON.stringify({ path: String.raw`C:\Users\Alice\private file.txt` })),
    ).toBe('{"path":"[LOCAL_PATH]"}');
    expect(sanitizeForPacket(String.raw`home is "C:\Users\Bob Smith".`)).toBe(
      'home is "[LOCAL_PATH]".',
    );
    expect(sanitizeForPacket("open '/home/bob smith/private notes.md' now")).toBe(
      "open '[LOCAL_PATH]' now",
    );
  });

  // Privacy comes before the prose around a path: a directory name may hold any number of spaces, so words between a
  // path and a later slash on the same line can go with it.
  it('replaces a path whose directories hold several spaces', () => {
    for (const input of [
      '/home/one two three four/private/file.txt',
      String.raw`C:\Users\Bob  Smith\private\file.txt`,
    ]) {
      expect(sanitizeForPacket(`see ${input} here`)).toBe('see [LOCAL_PATH] here');
    }
  });

  it('replaces a quoted path holding an escaped quote or the other kind of quote', () => {
    expect(
      sanitizeForPacket(JSON.stringify({ path: '/home/bob/private "sensitive notes".txt' })),
    ).toBe('{"path":"[LOCAL_PATH]"}');
    expect(sanitizeForPacket(`open "/home/bob's private/a b.md" now`)).toBe(
      'open "[LOCAL_PATH]" now',
    );
  });

  it('replaces a path in escaped quotes, as JSON inside a JSON string writes it', () => {
    expect(sanitizeForPacket(String.raw`open \"/home/bob/private notes.md\" now`)).toBe(
      String.raw`open \"[LOCAL_PATH]\" now`,
    );
  });

  // In shell single quotes a backslash is an ordinary character, so the next single quote closes the path.
  it('replaces a path in shell single quotes that ends with a backslash', () => {
    expect(sanitizeForPacket(String.raw`open '/home/bob/private notes\' now`)).toBe(
      "open '[LOCAL_PATH]' now",
    );
  });

  it('replaces a quoted POSIX path holding characters Windows forbids', () => {
    expect(sanitizeForPacket('open "/home/bob/a|private notes.txt" now')).toBe(
      'open "[LOCAL_PATH]" now',
    );
  });

  it('stays fast on hostile paths', () => {
    for (const hostile of [
      `C:\\${'a '.repeat(50_000)}`,
      `C:${'\\'.repeat(50_000)}x`,
      `${'C:\\a '.repeat(20_000)}`,
      `/home/${'a '.repeat(50_000)}`,
      `\\\\${'a\\'.repeat(50_000)} b`,
      `~/${'a b/'.repeat(30_000)}`,
      `"C:\\${'a '.repeat(50_000)}`,
      `${'"C:\\a '.repeat(20_000)}`,
      `${'"C:\\a\\"'.repeat(20_000)}`,
      `"/home/${'a\\"'.repeat(40_000)}`,
      `\\"/home/${'a '.repeat(50_000)}`,
      `${'\\"C:\\a '.repeat(20_000)}`,
      `'/home/${'a "'.repeat(40_000)}`,
      `password=${'\\ '.repeat(50_000)}`,
      `password=${`'a'"b"`.repeat(20_000)}`,
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

// The patterns above recognize paths by their shape; the paths the workspace knows are replaced exactly, whatever
// their prefix, quoting or spacing.
describe('known local paths', () => {
  const sanitize = createPacketSanitizer(
    ['/work/clients/acme/importer', String.raw`D:\clients\acme repo`, '/work/客户 acme'],
    { caseInsensitive: false },
  );

  it('replaces a known path and whatever follows it inside that path', () => {
    expect(sanitize('built /work/clients/acme/importer/src/app.ts today')).toBe(
      'built [LOCAL_PATH] today',
    );
    expect(sanitize('cd /work/clients/acme/importer && ls')).toBe('cd [LOCAL_PATH] && ls');
  });

  it('replaces a known path in any written form', () => {
    expect(sanitize(JSON.stringify({ path: String.raw`D:\clients\acme repo\notes.md` }))).toBe(
      '{"path":"[LOCAL_PATH]"}',
    );
    expect(sanitize('see D:/clients/acme repo/notes.md here')).toBe('see [LOCAL_PATH] here');
    expect(sanitize(String.raw`see D:\clients\acme repo here`)).toBe('see [LOCAL_PATH] here');
    expect(sanitize('at file:///work/%E5%AE%A2%E6%88%B7%20acme/src/app.js:3:9')).toBe(
      'at file:[LOCAL_PATH]:3:9',
    );
    expect(sanitize(String.raw`{"cwd":"\/work\/clients\/acme\/importer\/src"}`)).toBe(
      '{"cwd":"[LOCAL_PATH]"}',
    );
    expect(
      sanitize(
        String.raw`ls /d/clients/acme\ repo /cygdrive/d/clients/acme repo /mnt/d/clients/acme repo here`,
      ),
    ).toBe('ls [LOCAL_PATH] [LOCAL_PATH] [LOCAL_PATH] here');
    expect(sanitize('open "/work/clients/acme/importer/My Notes.md" now')).toBe(
      'open "[LOCAL_PATH]" now',
    );
    expect(sanitize('修复了/work/clients/acme/importer里的问题')).toBe(
      '修复了[LOCAL_PATH]里的问题',
    );
  });

  it('prefers the longest known path, so a folder name with a space stays whole', () => {
    const nested = createPacketSanitizer(['/build/fixture', '/build/fixture/client acme'], {
      caseInsensitive: false,
    });
    expect(nested('Fixed the importer in /build/fixture/client acme.')).toBe(
      'Fixed the importer in [LOCAL_PATH].',
    );
    expect(nested('see /build/fixture/other here')).toBe('see [LOCAL_PATH] here');
  });

  it('splits many known paths across patterns of bounded size, longest first', () => {
    // Shorter than the nested path and longer than its prefix, the fillers push the two into different patterns.
    const fillers = Array.from({ length: 5_000 }, (_, index) => `/filler-${index}/abcdefgh`);
    const many = createPacketSanitizer(
      [
        '/build/fixture',
        ...fillers,
        '/build/fixture/client acme',
        `/${'d'.repeat(4_000)}`,
        `/${'e'.repeat(40_000)}`,
      ],
      { caseInsensitive: false },
    );
    expect(many('Fixed the importer in /build/fixture/client acme.')).toBe(
      'Fixed the importer in [LOCAL_PATH].',
    );
    expect(many('see /filler-0/abcdefgh and /filler-4999/abcdefgh/x here')).toBe(
      'see [LOCAL_PATH] and [LOCAL_PATH] here',
    );
    expect(many(`see /${'d'.repeat(4_000)}/x here`)).toBe('see [LOCAL_PATH] here');
    // A path longer than Linux allows is left to the general patterns.
    expect(many(`see /${'e'.repeat(40_000)} here`)).toBe(`see /${'e'.repeat(40_000)} here`);
  });

  it('matches a name written composed or decomposed', () => {
    const accented = createPacketSanitizer(['/work/caf\u00e9'], { caseInsensitive: false });
    expect(accented('see /work/cafe\u0301/menu here')).toBe('see [LOCAL_PATH] here');
  });

  it('applies to command arguments', () => {
    expect(
      sanitizeArgsForPacket(['--root', '/work/clients/acme/importer', '--token', 'x'], sanitize),
    ).toEqual(['--root', '[LOCAL_PATH]', '--token', '[REDACTED]']);
  });

  it('matches whole path segments only', () => {
    expect(sanitize('see /work/clients/acme/importer-v2 here')).toBe(
      'see /work/clients/acme/importer-v2 here',
    );
  });

  it('matches letter case as the file system does', () => {
    const insensitive = createPacketSanitizer([String.raw`C:\Work\Acme`], {
      caseInsensitive: true,
    });
    expect(insensitive(String.raw`see c:\work\ACME\x.txt here`)).toBe('see [LOCAL_PATH] here');
  });

  it('ignores a bare root, which would match every path', () => {
    expect(createPacketSanitizer(['/', 'C:\\'])('see /usr/lib here')).toBe('see /usr/lib here');
  });

  it('stays fast on hostile text and many known paths', () => {
    const many = createPacketSanitizer(
      Array.from({ length: 200 }, (_, index) => `/work/client-${index}/repository`),
    );
    for (const hostile of [
      `/work/clients/acme/importer${'/a b'.repeat(40_000)}`,
      `${'/work/client-1/'.repeat(30_000)}`,
      `${'/work/clients/acme/importe'.repeat(10_000)}`,
      '/'.repeat(200_000),
      `"${'\\'.repeat(200_000)}`,
    ]) {
      const started = performance.now();
      sanitize(hostile);
      many(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
