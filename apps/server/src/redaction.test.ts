import { describe, expect, it } from 'vitest';

import { checkRequestSchema } from './check-policy.js';
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

describe('token values', () => {
  const tokens: Array<[string, string, number]> = [
    ['a fine-grained GitHub token', 'github_pat_', 22],
    ['a classic GitHub token', 'ghp_', 20],
    ['a GitLab token', 'glpat-', 20],
    ['a sk- key', 'sk-', 20],
    ['a Slack token', 'xoxb-', 10],
  ];
  for (const [name, prefix, least] of tokens) {
    it(`redacts ${name} from its shortest length on`, () => {
      expect(redactSecrets(joined(prefix, 'a'.repeat(least - 1)))).toBe(
        joined(prefix, 'a'.repeat(least - 1)),
      );
      expect(redactSecrets(joined(prefix, 'a'.repeat(least), ' tail'))).toBe('[REDACTED] tail');
    });
  }

  it('redacts a bearer value from its shortest length on, with its padding', () => {
    expect(redactSecrets('Bearer aaaaaaa')).toBe('Bearer aaaaaaa');
    expect(redactSecrets('Bearer aaaaaaaa== tail')).toBe('Bearer [REDACTED] tail');
  });

  const webTokens: Array<[string, string]> = [
    ['eyJaaaaaaaa.bbbbbbbb.cccccccc', '[REDACTED]'],
    ['-eyJaaaaaaaa.bbbbbbbb.cccccccc.dddddddd', '-[REDACTED].dddddddd'],
    ['eyJ-eyJaaaaaaaa.bbbbbbbb.cccccccc', '[REDACTED]'],
    // Too short in one part, so each stays, and a token after it does not.
    ['eyJaaaaaaa.bbbbbbbb.cccccccc', 'eyJaaaaaaa.bbbbbbbb.cccccccc'],
    ['eyJaaaaaaaa.bbbbbbb.cccccccc', 'eyJaaaaaaaa.bbbbbbb.cccccccc'],
    ['eyJaaaaaaaa.bbbbbbbb.ccccccc', 'eyJaaaaaaaa.bbbbbbbb.ccccccc'],
    ['eyJaaaaaaaa eyJaaaaaaaa.bbbbbbbb.cccccccc', 'eyJaaaaaaaa [REDACTED]'],
    ['eyJaaaaaaaa.b.eyJaaaaaaaa.bbbbbbbb.cccccccc', 'eyJaaaaaaaa.b.[REDACTED]'],
    [
      'eyJaaaaaaaa.bbbbbbbb.ccc.eyJdddddddd.eeeeeeee.ffffffff',
      'eyJaaaaaaaa.bbbbbbbb.ccc.[REDACTED]',
    ],
    // A part that holds a start of its own.
    ['eyJaaaaaaaa.eyJbbbbbbbb.eyJcccccccc.dddddddd', '[REDACTED].dddddddd'],
    ['eyJaaaaaaaa.eyJbbbbbbbb.cc eyJdddddddd', 'eyJaaaaaaaa.eyJbbbbbbbb.cc eyJdddddddd'],
  ];
  for (const [input, expected] of webTokens) {
    it(`reads "${input}" as JSON web tokens`, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }
});

describe('a credential value and its separator', () => {
  const [backslash, doubleQuote, singleQuote, newline, carriageReturn] = [92, 34, 39, 10, 13].map(
    (code) => String.fromCharCode(code),
  );
  // The value's rules as one pattern, which V8 can run on a short text only.
  const doubleQuoted = String.raw`"(?:[^"\\\n]|\\\r\n|\\[\s\S])*"?`;
  const singleQuoted = String.raw`'(?:[^'\\\n]|\\\r\n|\\[\s\S])*'?`;
  const escaped = String.raw`\\\r\n|\\[\s\S]`;
  const assignment = new RegExp(
    String.raw`(password=\s*)(?:(?:[^\s"',;\\]|${escaped})(?:${doubleQuoted}|${singleQuoted}|${escaped}|[^\s"',;\\])*|(?:${doubleQuoted}|${singleQuoted})(?:${doubleQuoted}|${singleQuoted}|${escaped}|[^\s"',;\\)\]}>&|])*)`,
    'gu',
  );
  const byThePattern = (text: string) =>
    text.replace(assignment, (match: string, head: string) => {
      const first = match[head.length];
      const wrapper = first === doubleQuote || first === singleQuote ? first : '';
      return `${head}${wrapper}[REDACTED]${wrapper}`;
    });

  it('reads every short value as the pattern of its rules does', { timeout: 60_000 }, () => {
    const parts = [
      doubleQuote,
      singleQuote,
      backslash,
      newline,
      carriageReturn,
      ' ',
      ',',
      'a',
      ')',
      String.fromCodePoint(0x1f600),
      String.fromCharCode(0xfdd0),
    ];
    let differences = 0;
    const read = (value: string, room: number) => {
      for (const text of [`password=${value}`, `password=${value} tail`]) {
        if (redactSecrets(text) !== byThePattern(text)) differences += 1;
      }
      if (room > 0) for (const part of parts) read(`${value}${part}`, room - 1);
    };
    read('', 5);
    expect(differences).toBe(0);
  });

  it('reads the separator as a name with any spaces before and after it', () => {
    expect(redactSecrets('password\t =\n x')).toBe('password\t =\n [REDACTED]');
    expect(redactSecrets('"password" : "x y" tail')).toBe('"password" : "[REDACTED]" tail');
    expect(redactSecrets(`password${String.fromCharCode(0xa0)}=x`)).toBe(
      `password${String.fromCharCode(0xa0)}=[REDACTED]`,
    );
    expect(redactSecrets('a-token token: x')).toBe('a-token token: [REDACTED]');
    // `secret` has no separator after it and `key` alone names no secret, so only the second one is an assignment.
    expect(redactSecrets('secret key=x secret_key=y')).toBe('secret key=x secret_key=[REDACTED]');
  });

  it('keeps a name that no value follows', () => {
    for (const text of [
      'password x',
      'password',
      'password=',
      'password= ',
      'password= , x',
      'password=;',
      `password=${backslash}`,
      '"password" x',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('redaction up to the largest output limit', () => {
  const limit = 10_000_000;
  const gives = (output: string) => () => output;
  const unchanged = (text: string) => text;
  const quotedValue = gives('password="[REDACTED]"');
  const singleQuotedValue = gives("password='[REDACTED]'");
  const token = gives('[REDACTED]');
  const cases: Array<[string, (length: number) => string, (text: string) => string]> = [
    ['a closed quoted value', (n) => `password="${'a'.repeat(n)}"`, quotedValue],
    ['a value with no closing quote', (n) => `password="${'a'.repeat(n)}`, quotedValue],
    ['a closed single-quoted value', (n) => `password='${'a'.repeat(n)}'`, singleQuotedValue],
    ['an open single-quoted value', (n) => `password='${'a'.repeat(n)}`, singleQuotedValue],
    ['an unquoted value', (n) => `password=${'a'.repeat(n)}`, gives('password=[REDACTED]')],
    [
      'a value of characters past U+FFFF',
      (n) => `password="${String.fromCodePoint(0x1f600).repeat(n / 2)}"`,
      quotedValue,
    ],
    [
      'an unquoted value of the marks a packet sanitizer uses',
      (n) => `password=${String.fromCharCode(0xfdd0).repeat(n)}`,
      gives('password=[REDACTED]'),
    ],
    ['a word after a quoted part', (n) => `password="a"${'b'.repeat(n)}`, quotedValue],
    ['a quoted value of escapes', (n) => `password="${'\\a'.repeat(n / 2)}"`, quotedValue],
    [
      'an unquoted value of escapes',
      (n) => `password=${'\\a'.repeat(n / 2)}`,
      gives('password=[REDACTED]'),
    ],
    ['a value of adjacent quoted parts', (n) => `password=${'"a"'.repeat(n / 3)}`, quotedValue],
    [
      'a value with text around it',
      (n) => `x password="${'a'.repeat(n)}" y`,
      gives('x password="[REDACTED]" y'),
    ],
    [
      'spaces before a separator',
      (n) => `password${' '.repeat(n)}=a`,
      (text) => `${text.slice(0, -1)}[REDACTED]`,
    ],
    [
      'spaces after a separator',
      (n) => `password=${' '.repeat(n)}a`,
      (text) => `${text.slice(0, -1)}[REDACTED]`,
    ],
    ['spaces that no value follows', (n) => `a-b-c-d-e-f-token=${' '.repeat(n)},`, unchanged],
    ['names with no separator', (n) => 'token '.repeat(n / 6), unchanged],
    ['a chain of name prefixes', (n) => 'a-'.repeat(n / 2), unchanged],
    ['a fine-grained GitHub token', (n) => joined('github_pat_', 'a'.repeat(n)), token],
    ['a classic GitHub token', (n) => joined('ghp_', 'a'.repeat(n)), token],
    ['a GitLab token', (n) => joined('glpat-', 'a'.repeat(n)), token],
    ['a sk- key', (n) => joined('sk-', 'a'.repeat(n)), token],
    ['a Slack token', (n) => joined('xoxb-', 'a'.repeat(n)), token],
    ['a web token with a long first part', (n) => `eyJ${'a'.repeat(n)}.bbbbbbbb.cccccccc`, token],
    ['a web token with a long last part', (n) => `eyJaaaaaaaa.bbbbbbbb.${'c'.repeat(n)}`, token],
    ['a web token with no period', (n) => `eyJ${'a'.repeat(n)}`, unchanged],
    ['starts of web tokens with no period', (n) => 'eyJ-'.repeat(n / 4), unchanged],
    [
      'starts of web tokens after one period',
      (n) => `eyJaaaaaaaa.${'eyJ-'.repeat(n / 4)}`,
      unchanged,
    ],
    ['a bearer value', (n) => `Bearer ${'a'.repeat(n)}`, gives('Bearer [REDACTED]')],
    [
      'padding after a bearer value',
      (n) => `Bearer aaaaaaaa${'='.repeat(n)}`,
      gives('Bearer [REDACTED]'),
    ],
  ];

  it('runs at the largest output limit a check may set', () => {
    const maxOutputBytes = checkRequestSchema.shape.maxOutputBytes;
    expect(maxOutputBytes.safeParse(limit).success).toBe(true);
    expect(maxOutputBytes.safeParse(limit + 1).success).toBe(false);
  });

  // A pattern that keeps a backtrack entry per round throws at the longest texts. One that takes quadratic time misses
  // its budget at the shortest, in seconds, long before a text at the limit would take it hours. A character past
  // Latin-1 makes V8 store the whole text in two bytes per character, where a pattern with the `u` flag keeps more
  // entries.
  for (const [name, build, expected] of cases) {
    it(`reads ${name} in time proportional to its length`, { timeout: 180_000 }, () => {
      const han = String.fromCharCode(0x5ba2);
      for (let length = limit / 64; length <= limit; length *= 2) {
        const text = build(length);
        const started = performance.now();
        const output = redactSecrets(`${han}\n${text}`);
        const elapsed = performance.now() - started;
        expect(output === `${han}\n${expected(text)}`, `the output at ${length}`).toBe(true);
        expect(elapsed, `the time at ${length}`).toBeLessThan(250 + length / 1_000);
      }
      const text = build(limit);
      expect(redactSecrets(text) === expected(text), 'the output at the limit').toBe(true);
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
    const fillers = Array.from({ length: 2_500 }, (_, index) => `/filler-${index}/abcdefgh`);
    const many = createPacketSanitizer(
      [
        '/build/fixture',
        ...fillers,
        '/build/fixture/client acme',
        `/${'d'.repeat(500)}`,
        `/${'e'.repeat(4_000)}`,
      ],
      { caseInsensitive: false },
    );
    expect(many('Fixed the importer in /build/fixture/client acme.')).toBe(
      'Fixed the importer in [LOCAL_PATH].',
    );
    expect(many('see /filler-0/abcdefgh and /filler-2499/abcdefgh/x here')).toBe(
      'see [LOCAL_PATH] and [LOCAL_PATH] here',
    );
    expect(many(`see /${'d'.repeat(500)}/x here`)).toBe('see [LOCAL_PATH] here');
    // A known path longer than 512 characters is left to the general patterns.
    expect(many(`see /${'e'.repeat(4_000)} here`)).toBe(`see /${'e'.repeat(4_000)} here`);
  });

  it('stays within V8 limits and keeps the known paths that come first', () => {
    const hangul = `/${Array.from({ length: 8 }, () => '한'.repeat(60)).join('/')}`;
    const deep = Array.from({ length: 40 }, (_, index) => `/p${index}${'/a'.repeat(240)}`);
    const later = Array.from({ length: 5_000 }, (_, index) => `/later/client-${index}/repository`);
    const bounded = createPacketSanitizer([hangul, ...deep, `/${'é'.repeat(3_459)}`, ...later], {
      caseInsensitive: false,
    });
    expect(bounded(`see ${hangul}/x here`)).toBe('see [LOCAL_PATH] here');
    expect(bounded(`see ${hangul.normalize('NFD')}/x here`)).toBe('see [LOCAL_PATH] here');
    expect(bounded(`see /p39${'/a'.repeat(240)}/x here`)).toBe('see [LOCAL_PATH] here');
    expect(bounded('see /later/client-0/repository here')).toBe('see [LOCAL_PATH] here');
    // Past 100,000 characters of known paths in all, the rest are left to the general patterns.
    expect(bounded('see /later/client-4999/repository here')).toBe(
      'see /later/client-4999/repository here',
    );
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

  it('reads what follows a known path at least as far as the general patterns do', () => {
    const cases: Array<[string, string, string]> = [
      ['/home/bob', String.raw`cp /home/bob/My\ Documents/secret-plan.txt .`, 'cp [LOCAL_PATH] .'],
      [
        '/home/bob',
        'restore /home/bob/backups/2024-01-01T10:00:00/payroll.sql now',
        'restore [LOCAL_PATH] now',
      ],
      ['/home/bob', 'see /home/bob/a|b/what?/a`b/secret.txt now', 'see [LOCAL_PATH] now'],
      ['/home/bob', 'see /home/bob/run:12 archive/payroll.csv now', 'see [LOCAL_PATH] now'],
      [
        '/Users/bob',
        'see /Users/bob/Screenshots/Screen Shot 2024-01-01 at 10:00:00/x.png now',
        'see [LOCAL_PATH] now',
      ],
      [
        String.raw`C:\work\acme`,
        String.raw`opened C:\work\acme\Client's Data\Q3 report\summary.xlsx today`,
        'opened [LOCAL_PATH] today',
      ],
      [
        String.raw`C:\Users\Bob Smith`,
        String.raw`opened C:\Users\Bob Smith\a` + '`' + String.raw`b\Secret Folder\x.txt today`,
        'opened [LOCAL_PATH] today',
      ],
    ];
    for (const [known, text, expected] of cases) {
      // The general patterns alone already remove each of these paths whole.
      expect(sanitizeForPacket(text)).toBe(expected);
      expect(createPacketSanitizer([known])(text)).toBe(expected);
    }
  });

  it('replaces a known path before credentials, so an assignment keeps none of it', () => {
    const home = createPacketSanitizer([String.raw`C:\Users\Bob Smith`]);
    expect(
      home(
        String.raw`GOOGLE_APPLICATION_CREDENTIALS=C:\Users\Bob Smith\AppData\Roaming\gcloud\adc.json`,
      ),
    ).toBe('GOOGLE_APPLICATION_CREDENTIALS=[REDACTED]');
    const tokenLike = joined('/work/sk', '-learn-experiments-2024');
    const repos = createPacketSanitizer(['/work/acme repo', tokenLike]);
    expect(
      sanitizeArgsForPacket(['sign', '--private-key=/work/acme repo/keys/id_ed25519'], repos),
    ).toEqual(['sign', '--private-key=[REDACTED]']);
    expect(repos(`see ${tokenLike}/notes here`)).toBe('see [LOCAL_PATH] here');
    // A shell-quoted part after the known path stays whole, so the assignment still takes it.
    const posixHome = createPacketSanitizer(['/home/bob'], { caseInsensitive: false });
    expect(posixHome("TOKEN=/home/bob/'secret plan.txt'")).toBe('TOKEN=[REDACTED]');
    expect(posixHome('TOKEN=/home/bob/"secret plan.txt"')).toBe('TOKEN=[REDACTED]');
    expect(posixHome("cd /home/bob/'my dir'/x && ls")).toBe('cd [LOCAL_PATH] && ls');
  });

  it('replaces a known path in file URLs, JSON escapes and shell escapes', () => {
    const home = createPacketSanitizer([String.raw`C:\Users\Bob Smith`], { caseInsensitive: true });
    expect(home('see file:///c%3A/Users/Bob%20Smith/notes.md here')).toBe(
      'see file:///[LOCAL_PATH] here',
    );
    const repos = createPacketSanitizer(
      [
        '/work/acme repo',
        '/work/acme (old)',
        "/work/bob's repo",
        '/work/客户 acme',
        String.raw`D:\clients\acme repo`,
        '~/work/home repo',
      ],
      { caseInsensitive: false },
    );
    expect(repos('see file://localhost/work/acme%20repo/src/x.py here')).toBe(
      'see file://localhost[LOCAL_PATH] here',
    );
    expect(repos('see file:///work/acme%20%28old%29/x here')).toBe('see file:[LOCAL_PATH] here');
    expect(repos('see file:///work/bob%27s%20repo/y here')).toBe('see file:[LOCAL_PATH] here');
    expect(repos('see file:///work/%e5%ae%a2%e6%88%b7%20acme/src here')).toBe(
      'see file:[LOCAL_PATH] here',
    );
    expect(repos(String.raw`{"cwd": "/work/\u5ba2\u6237 acme/src"}`)).toBe(
      '{"cwd": "[LOCAL_PATH]"}',
    );
    expect(repos(String.raw`{"cmd": "cd \/mnt\/d\/clients\/acme repo && ls"}`)).toBe(
      '{"cmd": "cd [LOCAL_PATH] && ls"}',
    );
    expect(repos('Fixed it in ~/work/home repo. Also in $HOME/work/home repo/x')).toBe(
      'Fixed it in [LOCAL_PATH]. Also in [LOCAL_PATH]',
    );
    expect(repos(String.raw`cd /work/acme\ \(old\)/src && cd /work/bob\'s\ repo/src`)).toBe(
      'cd [LOCAL_PATH] && cd [LOCAL_PATH]',
    );
    const apostrophe = createPacketSanitizer([String.raw`C:\Users\Bob O'Brien`]);
    expect(
      apostrophe(String.raw`see 'C:\Users\Bob O'Brien\notes.txt' and C:\Users\Bob O'Brien\x here`),
    ).toBe("see '[LOCAL_PATH]' and [LOCAL_PATH] here");
    expect(apostrophe(String.raw`at Object.<anonymous> (C:\Users\Bob O'Brien\src\x.js:3:9)`)).toBe(
      'at Object.<anonymous> ([LOCAL_PATH]:3:9)',
    );
    const literal = createPacketSanitizer(['/work/%ab', '/work/100%25'], {
      caseInsensitive: false,
    });
    expect(literal('see /work/%ab/secret.txt')).toBe('see [LOCAL_PATH]');
    expect(literal('see file:///work/%25ab/x here')).toBe('see file:[LOCAL_PATH] here');
    expect(literal('see /work/100%25/x here')).toBe('see [LOCAL_PATH] here');
    const percent = createPacketSanitizer(['/work/100% done'], { caseInsensitive: false });
    expect(percent('see file:///work/100%25%20done/x here')).toBe('see file:[LOCAL_PATH] here');
    expect(percent('see /work/100% done/y here')).toBe('see [LOCAL_PATH] here');
  });

  it('finds a known path after a command-line flag or in a URL', () => {
    const repos = createPacketSanitizer(
      ['/work/acme', '/work/acme repo', String.raw`D:\clients\acme`],
      { caseInsensitive: false },
    );
    expect(repos('cc -I/work/acme/include main.c')).toBe('cc -I[LOCAL_PATH] main.c');
    expect(repos('ld --library-path/work/acme/lib -o x')).toBe(
      'ld --library-path[LOCAL_PATH] -o x',
    );
    expect(repos('GET http://localhost:5173/@fs/work/acme repo/src/main.ts')).toBe(
      'GET http://localhost:5173/@fs[LOCAL_PATH]',
    );
    expect(repos('open vscode://file/work/acme repo/src/x.ts now')).toBe(
      'open vscode://file[LOCAL_PATH] now',
    );
    expect(repos(String.raw`cl /ID:\clients\acme\include x.c`)).toBe('cl /I[LOCAL_PATH] x.c');
    // A relative path that merely holds a known path's segments stays, and so does a remote URL.
    expect(createPacketSanitizer(['/app'])('built src/app/page.tsx')).toBe(
      'built src/app/page.tsx',
    );
    for (const text of [
      'cat fixtures/-I/work/acme/result.json',
      '{"url":"https://example.org/work/acme/status"}',
    ]) {
      expect(repos(text)).toBe(text);
    }
  });

  it('ends a Windows path at the semicolon of a PATH list', () => {
    expect(
      sanitizeForPacket(String.raw`PATH=C:\tools\bin;E:\Private Stuff\Bob Smith\tools;C:\Windows`),
    ).toBe('PATH=[LOCAL_PATH];[LOCAL_PATH];[LOCAL_PATH]');
    // After a known path, the rest of the list goes with it, since a name may hold `;`.
    expect(
      sanitize(String.raw`PATH=D:\clients\acme repo\bin;E:\Private Stuff\Bob Smith\tools`),
    ).toBe('PATH=[LOCAL_PATH]');
  });

  it('removes no less after a known path than the general patterns do', () => {
    // A fixed sample of the differential check: each text holds a marker below a known path.
    const cases: Array<[string, string]> = [
      ['/home/bob', 'see /home/bob/;!MARKER and more'],
      ['/Users/bob', '/Users/bob/,;^MARKER/:!?/& )'],
      ['/home/bob', 'see /home/bob/x:12)MARKER here'],
      ['/tmp/run', String.raw`"/tmp/run/[{;@/_MARKER?\(`],
      // A backslash separates on Windows and is a character or an escape in a POSIX name.
      [
        String.raw`C:\Users\Bob Smith`,
        String.raw`file://C:\Users\Bob Smith\(_ 客MARKER'\'~客) done`,
      ],
      [String.raw`C:\Users\Bob Smith`, String.raw`{"p":"C:\Users\Bob Smith\7^= '\'MARKER)`],
      [
        String.raw`C:\Users\Bob Smith`,
        String.raw`file://C:\Users\Bob Smith\^+é7!$\[é ,MARKER\ * and more`,
      ],
      [String.raw`D:\work\acme`, String.raw`x=D:\work\acme\+] '\{~\MARKER!:Z#'`],
      ['/tmp/run', String.raw`see /tmp/run/{aé \MARKER)|/x`],
      ['/home/bob', String.raw`x=/home/bob/-) \MARKER &/;/\'{}?\)'`],
      ['/tmp/run', 'file:///tmp/run/:7 7/_^$MARKER]^)'],
      [String.raw`C:\Users\Bob Smith`, String.raw`Bearer C:\Users\Bob Smith/a7bZ/b$(.MARKER`],
      // In a credential value, the value's own rules read a quote after a Windows path's segments, and a backslash
      // after its last one.
      [String.raw`D:\work\acme`, String.raw`--token=D:\work\acme\'[\ b\MARKER.+,`],
      [String.raw`D:\work\acme`, String.raw`TOKEN=D:\work\acme\ MARKER]*\Zb%\[7( done`],
      [String.raw`D:\work\acme`, String.raw`password: D:\work\acme/:'/=# '&MARKER{.`],
      // A Windows name may hold `;` and `?` here, so a path written right after one goes with it.
      [String.raw`C:\Users\Bob Smith`, String.raw`cd C:\Users\Bob Smith/}a;~/b?&MARKER`],
    ];
    for (const [known, text] of cases) {
      expect(sanitizeForPacket(text)).not.toContain('MARKER');
      expect(createPacketSanitizer([known])(text)).not.toContain('MARKER');
    }
  });

  it('removes no less after a known path than the general patterns do, on generated paths', () => {
    // A seeded generator puts a marker in a path below a known path, written with characters a name may hold.
    // A 32-bit generator (mulberry32): products stay exact in integer arithmetic, so the cases do not repeat.
    let state = 11;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
    function pick<T>(items: readonly T[]): T {
      return items[Math.floor(random() * items.length)] as T;
    }
    const knownPaths = ['/home/bob', '/Users/bob', String.raw`C:\Users\Bob Smith`];
    const sanitizers = knownPaths.map((known) =>
      createPacketSanitizer([known], { caseInsensitive: true }),
    );
    const characters = [..."aZ7 ':|?*`()&;,=#%-._~!@$+[]{}^é客"];
    const escapes = [String.raw`\ `, String.raw`\(`, String.raw`\'`];
    const contexts: Array<[string, string]> = [
      ['', ''],
      ['cd ', ' && ls'],
      ['"', '"'],
      ["'", "'"],
      ['(', ')'],
      ['', ':12:5'],
      ['x=', ' y'],
      ['TOKEN=', ''],
      ['TOKEN=', ' done'],
    ];
    let checked = 0;
    for (let round = 0; round < 2_000; round += 1) {
      const index = Math.floor(random() * knownPaths.length);
      const separator = index === 2 ? pick(['\\', '/']) : '/';
      // The first part may also go on in the known path's last segment.
      const glue = random() < 0.25 ? '' : separator;
      const parts = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
          random() < 0.15 ? pick(escapes) : pick(characters),
        ).join(''),
      );
      const at = Math.floor(random() * parts.length);
      parts[at] = `${parts[at] ?? ''}MARKER`;
      const [before, after] = pick(contexts);
      const text = `${before}${knownPaths[index] ?? ''}${glue}${parts.join(separator)}${after}`;
      // A letter of a script other than Latin right after a known path reads as prose, as the docs state.
      if (glue === '' && /^(?!\p{Script=Latin})\p{L}/u.test(parts[0] ?? '')) continue;
      if (sanitizeForPacket(text).includes('MARKER')) continue;
      checked += 1;
      expect(sanitizers[index]?.(text), text).not.toContain('MARKER');
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it('matches whole path segments only', () => {
    expect(sanitize('see /work/clients/acme/importer-v2 here')).toBe(
      'see /work/clients/acme/importer-v2 here',
    );
    const roots = createPacketSanitizer(['/work', '/app'], { caseInsensitive: false });
    const routes = String.raw`route "/workers/status", '/workshop notes', {"r":"/workflows"} and "/apple-touch-icon.png"`;
    expect(roots(routes)).toBe(routes);
    const siblings = 'see "/work/clients/acme/importer-v2/x" and /work/clients/acme/importeré/x';
    expect(sanitize(siblings)).toBe(siblings);
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
    const home = createPacketSanitizer(['~/projects'], { caseInsensitive: false });
    for (const hostile of [
      `/work/clients/acme/importer${'/a b'.repeat(40_000)}`,
      `${'/work/client-1/'.repeat(30_000)}`,
      `${'/work/clients/acme/importe'.repeat(10_000)}`,
      '/'.repeat(200_000),
      `"${'\\'.repeat(200_000)}`,
      // Many places where a root may start, with no space or slash between them: looking back for a URL's host
      // stops at the one before.
      '%'.repeat(200_000),
      '-~'.repeat(100_000),
      'a-\\'.repeat(100_000),
      '~\\$HOME\\%USERPROFILE%\\'.repeat(20_000),
    ]) {
      const started = performance.now();
      sanitize(hostile);
      many(hostile);
      home(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("stays linear when a known path's segments begin with a space", () => {
    // `/\ a` splits two ways, a separator run and an escaped space, unless only one of them is offered.
    const spaced = createPacketSanitizer([`/x${'/ a'.repeat(150)}/end`], {
      caseInsensitive: false,
    });
    const started = performance.now();
    spaced(`see /x${String.raw`/\ a`.repeat(150)}/enX here`);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('keeps a credential whole when its line or its name goes on inside a known path', () => {
    const [backslash, newline, tab] = [92, 10, 9].map((code) => String.fromCharCode(code));
    const known = createPacketSanitizer(['/home/bob', '/work/token', '/work/acme'], {
      caseInsensitive: false,
    });
    // A backslash before a line break or a tab escapes it, so the value goes on.
    expect(known(`TOKEN=/home/bob/${backslash}${newline}secret`)).toBe('TOKEN=[REDACTED]');
    expect(known(`TOKEN=/home/bob/${backslash}${tab}secret`)).toBe('TOKEN=[REDACTED]');
    // The known path ends in the assignment's own name, or sits inside a bearer value, a short one included.
    expect(known('/work/token=supersecret')).toBe('[LOCAL_PATH]=[REDACTED]');
    expect(known('Bearer abc-/work/acme/secret')).toBe('Bearer [REDACTED]');
    expect(known('Bearer abc-/work/acme/x')).toBe('Bearer [REDACTED]');
    // A shell writes an escaped backslash as two, so the quote after them opens a quoted part of the value.
    expect(known(String.raw`TOKEN=/work/acme\\'x SECRET'`)).toBe('TOKEN=[REDACTED]');
    // A known path that ends in the word a bearer value follows keeps it, so the value still goes.
    const bearer = createPacketSanitizer(['/work/Bearer', '/home/Bearer'], {
      caseInsensitive: false,
    });
    expect(bearer('/work/Bearer abcdefgh')).toBe('[LOCAL_PATH] [REDACTED]');
    // With no bearer value after it, the kept word is read as part of the path that goes on.
    expect(bearer('see /home/Bearer my notes/secret.txt now')).toBe('see [LOCAL_PATH] now');
  });

  it("reads on where the text continues a known path's last segment", () => {
    const known = createPacketSanitizer(
      ['/Users/bob/project', String.raw`C:\Users\Bob Smith\project`, '/home/bob'],
      { caseInsensitive: false },
    );
    // A copy of a folder, as a file manager names it, holds the known name and more.
    expect(known('see /Users/bob/project copy/secret.txt now')).toBe('see [LOCAL_PATH] now');
    expect(known(String.raw`see C:\Users\Bob Smith\project copy\secret.txt now`)).toBe(
      'see [LOCAL_PATH] now',
    );
    expect(known('see /home/bob(1)/secret.txt now')).toBe('see [LOCAL_PATH] now');
    // A POSIX name may go on with a backslash, a colon or a semicolon.
    expect(known(String.raw`see /home/bob\secret.txt now`)).toBe('see [LOCAL_PATH] now');
    expect(known('see /home/bob:secret.txt now')).toBe('see [LOCAL_PATH] now');
    expect(known('see /home/bob;secret now')).toBe('see [LOCAL_PATH] now');
    // A JSON-escaped slash may follow a space in the segment, as the general patterns read it.
    expect(known(String.raw`see /home/bob \/secret.txt now`)).toBe('see [LOCAL_PATH] now');
    // Prose after a path stays: punctuation, a line and column, and words no separator follows.
    expect(known('(see /home/bob), /home/bob. Then /home/bob:12:5 and /home/bob more')).toBe(
      '(see [LOCAL_PATH]), [LOCAL_PATH]. Then [LOCAL_PATH]:12:5 and [LOCAL_PATH] more',
    );
    expect(known('see /home/bob:12:5. Next')).toBe('see [LOCAL_PATH]:12:5. Next');
    expect(known('see /home/bob，请重试')).toBe('see [LOCAL_PATH]，请重试');
  });

  it('reads private-use characters as text and noncharacters as U+FFFD', () => {
    const [glyph, posixMark, windowsMark, replacement] = [0xe000, 0xfdd0, 0xfdd1, 0xfffd].map(
      (code) => String.fromCharCode(code),
    );
    const known = createPacketSanitizer(['/home/bob'], { caseInsensitive: false });
    expect(known(`normal ${glyph} prose`)).toBe(`normal ${glyph} prose`);
    expect(known(`see /home/bob/${glyph}secret.txt now`)).toBe('see [LOCAL_PATH] now');
    expect(known(`a ${posixMark} b ${windowsMark} c`)).toBe(`a ${replacement} b ${replacement} c`);
    expect(known(`see /home/bob/${windowsMark}secret.txt now`)).toBe('see [LOCAL_PATH] now');
    // So they read with no known path, and in a known path that holds one.
    expect(createPacketSanitizer([])(`a ${posixMark} b`)).toBe(`a ${replacement} b`);
    const marked = createPacketSanitizer([`/work/${posixMark}`], { caseInsensitive: false });
    expect(marked(`see /work/${posixMark}/secret.txt now`)).toBe('see [LOCAL_PATH] now');
  });

  it('reads what follows a known path by the rules of the system its root is written for', () => {
    const known = createPacketSanitizer(
      [String.raw`C:\Users\Bob Smith`, '/home/bob', '~/projects'],
      {
        caseInsensitive: true,
      },
    );
    // On Windows either slash separates and nothing escapes; an apostrophe is part of a name.
    expect(known(String.raw`type C:\Users\Bob Smith\(old) notes\'draft'\x.txt now`)).toBe(
      'type [LOCAL_PATH] now',
    );
    expect(known(String.raw`dir ~\projects\a b\c.txt now`)).toBe('dir [LOCAL_PATH] now');
    // A POSIX shell on Windows names the same folder and escapes a space in it.
    expect(known(String.raw`cd /c/Users/Bob\ Smith/my\ notes/x && ls`)).toBe(
      'cd [LOCAL_PATH] && ls',
    );
    // In a POSIX name, a backslash before a letter is part of the name.
    expect(known(String.raw`see /home/bob/notes\draft x/y.txt now`)).toBe('see [LOCAL_PATH] now');
  });

  it('leaves a known path alone in a remote URL and in a relative path such as @fs/x or @/x', () => {
    const known = createPacketSanitizer(['/work/acme'], { caseInsensitive: false });
    for (const text of [
      'GET https://[2001:db8::1]/work/acme/status',
      'GET https://例子.中国/work/acme/status',
      'cat fixtures/@fs/work/acme/status',
      'import "@/work/acme/status"',
    ]) {
      expect(known(text)).toBe(text);
    }
    expect(known('GET http://localhost:5173/@fs/work/acme/x.ts')).toBe(
      'GET http://localhost:5173/@fs[LOCAL_PATH]',
    );
    // A bracket that closes a log prefix, unlike one that closes a URL's IPv6 host, comes before a path.
    expect(known('[INFO]/work/acme/secret.txt')).toBe('[INFO][LOCAL_PATH]');
    // A URL's host ends at a quote, so a path in the next field is found.
    expect(known('{"url":"https://example.com","root":"/work/acme/secret.txt"}')).toBe(
      '{"url":"https://example.com","root":"[LOCAL_PATH]"}',
    );
  });

  it('withholds a text longer than a million characters', () => {
    const known = createPacketSanitizer(['/work/acme'], { caseInsensitive: false });
    const withheld = '[REDACTED: text too long to sanitize]';
    expect(known(`"/work/acme/${'a'.repeat(1_000_000)}"`)).toBe(withheld);
    expect(sanitizeForPacket(`"/home/${'a'.repeat(1_000_000)}"`)).toBe(withheld);
    expect(known(`"/work/acme/${'a'.repeat(999_000)}"`)).toBe('"[LOCAL_PATH]"');
  });
});
