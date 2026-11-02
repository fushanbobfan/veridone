// A name that ends in a secret word, written as an assignment, a header or a JSON field. The word must end the
// name, so `max_tokens` and `token_count` stay readable while `NPM_TOKEN` and `AWS_SECRET_ACCESS_KEY` lose their
// values. A quoted value is replaced up to its closing quote, past escaped quotes and escaped line breaks, or to the
// end of the line when the output was cut off before the quote closed. A value may join adjacent parts, as shell
// quoting does in `'alpha'"beta"` or `alpha\ beta`, and ends at whitespace. A value that starts unquoted keeps the
// characters a shell word may hold, `}` included; after a quoted start, `} ] ) >` close a structure and `& |` start a
// shell operator, so they end the value, as in `{"password": "x"}` or `'x'&&echo`. The name's prefix is bounded: check
// output comes from the commit under review, and an unbounded prefix takes quadratic time on input such as `a-a-a-…`.
// Each part of a value starts with a different character, so it is read once.
const secretWord =
  'password|passwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?';
const doubleQuoted = String.raw`"(?:[^"\\\n]|\\\r\n|\\[\s\S])*"?`;
const singleQuoted = String.raw`'(?:[^'\\\n]|\\\r\n|\\[\s\S])*'?`;
const escaped = String.raw`\\\r\n|\\[\s\S]`;
const secretValue = String.raw`(?:[^\s"',;\\]|${escaped})(?:${doubleQuoted}|${singleQuoted}|${escaped}|[^\s"',;\\])*|(?:${doubleQuoted}|${singleQuoted})(?:${doubleQuoted}|${singleQuoted}|${escaped}|[^\s"',;\\)\]}>&|])*`;
const secretAssignment = new RegExp(
  String.raw`\b((?:[a-z0-9]{1,40}[_-]){0,6}(?:${secretWord}))(["']?)(\s*[:=]\s*)(?:${secretValue})`,
  'giu',
);
// An option such as `--token` whose value is the next argument.
const secretOption = new RegExp(
  String.raw`^--?(?:[a-z0-9]{1,40}[_-]){0,6}(?:${secretWord})$`,
  'iu',
);
const tokenValues = [
  /\bgithub_pat_[A-Za-z0-9_]{22,}/gu,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}/gu,
  /\bgl(?:pat|ptt)-[A-Za-z0-9_-]{20,}/gu,
  /\bsk-[A-Za-z0-9_-]{20,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gu;
const keyBegin = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/gu;
const keyEnd = /-----END [A-Z ]{0,40}PRIVATE KEY-----/gu;

// A path inside quotes runs to its closing quote, whatever it holds; these patterns go first. Double quotes take
// backslash escapes, as JSON and JavaScript write them; single quotes take none, as in the shell; quotes that are
// themselves escaped, as JSON written inside a JSON string has them, close at the next escaped quote. A run stops at
// the first quote of its kind, so each one is read once.
const pathStart = String.raw`(?:[A-Za-z]:[\\/]|\\{2,}[^\s\\<>:"|?*]|\/(?:Users|home|var|tmp|opt|etc|mnt|srv|root|Volumes|private|media)\/|~\/)`;
const quotedPath = new RegExp(
  String.raw`(?<!\\)"${pathStart}(?:[^"\\\n]|\\[\s\S])*"|'${pathStart}[^'\n]*'|\\"${pathStart}(?:[^"\\\n]|\\(?!")[\s\S])*\\"`,
  'gu',
);
// Outside quotes, separators may repeat, as in JSON-escaped Windows paths (`C:\\Users\\…`). A segment holds spaces
// inside it when another separator follows, as in `C:\Program Files\` or `/home/Bob Smith/`; the last segment ends at
// the first space, so the prose after a path stays. Privacy comes first: words between a path and a later slash on the
// same line, as in `/home/page and verify pass/fail`, go with the path. A Windows segment ends at `;`, which separates
// the entries of a PATH list. Each alternative either ends at a separator or cannot hold a space, so a segment is read
// once: the patterns take linear time.
const windowsPath =
  /\b[A-Za-z]:[\\/]+(?:(?:[^\s\\/<>:"|?*;](?:[^\\/<>:"|?*;\n]*[^\s\\/<>:"|?*;])?(?=[\\/])|[^\s\\/<>:"|?*;]+)[\\/]*)*/gu;
const uncPath =
  /(?<![\w\\:])\\{2,}[^\s\\<>:"|?*]+(?:\\+(?:[^\s\\<>:"|?*](?:[^\\<>:"|?*\n]*[^\s\\<>:"|?*])?(?=\\)|[^\s\\<>:"|?*]+))+\\*/gu;
const privatePosixPath =
  /(?<![\w.])\/(?:Users|home|var|tmp|opt|etc|mnt|srv|root|Volumes|private|media)(?:\/+(?:[^\s/<>'"](?:[^/<>'"\n]*[^\s/<>'"])?(?=\/)|[^\s/<>'"]+))+\/?/gu;
const homeRelativePath =
  /(?<![\w/])~(?:\/+(?:[^\s/<>'"](?:[^/<>'"\n]*[^\s/<>'"])?(?=\/)|[^\s/<>'"]+))+\/?/gu;

// A known local path, such as a workspace root or the user's home, matches exactly, in each way text writes it:
// - with separators of either kind, repeated or JSON-escaped (`D:/x`, `D:\x`, `D:\\x`, `\/work\/x`);
// - with a character percent-encoded, as a file URL writes it, in either case of hex (`%20`, `c%3A` for a drive), as
//   JSON writes a character past ASCII (`\u5ba2`), or escaped with a backslash, as a shell writes it (`acme\ \(old\)`);
// - with a Windows drive named as a POSIX shell on Windows names it (`/d/x`, `/mnt/d/x`, `/cygdrive/d/x`), and a path
//   under the home directory written from `~`, `$HOME` or `%USERPROFILE%`.
// A match starts where no word character, period or separator comes before it, or right after a command-line flag
// (`-I/x`), a URL's scheme and host (`file://localhost/x`, `vscode://file/x`) or Vite's `/@fs`. A separator never comes
// just before the start, so a run of separators is read once; a drive letter may follow anything, as in `/ID:\x`. The
// known path's last segment must end there: a Latin letter, digit, mark, `_` or `-` after it continues a longer name, so
// `importer` leaves `importer-v2` and `importeré` alone, while a Chinese character after it reads as prose. What follows
// a separator then belongs to the path, read at least as far as the general patterns read it; after a quote, the match
// runs to the closing quote. The known paths share prefix trees, so a match attempt follows one path through a tree.
// The first character of a segment takes no shell escape, which a separator run could also claim, so no text can be
// read two ways and a failed attempt costs time in proportion to the path.
//
// V8 compiles a regular expression on first use, and it refuses one past a size limit or a sequence deep enough to
// exhaust its stack, and compiles many separator loops in one pattern slowly. A known path longer than 512 characters
// is left to the general patterns, and so are the known paths past the first 100,000 characters in all; the rest go
// into trees of bounded size, longest paths first, so a longer path still wins over its prefix.
const knownPathMaxLength = 512;
const knownPathsMaxLength = 100_000;
const treeMaxLength = 100_000;
const treeMaxSeparators = 1_000;
const separatorRun = String.raw`[\\/]+`;
// The lookbehinds run only where a root's first character follows, so each reads back over one word at most once.
const rootStart = String.raw`(?:(?<![\w.\\/])|(?<=(?<![\w-])-{1,2}[A-Za-z][\w-]*)|(?<=:\/\/[\w.:@-]*)|(?<=\/@fs))`;
const posixRoot = String.raw`(?=[\\/])${rootStart}${separatorRun}`;
const homeRoot = String.raw`(?=[~$%])${rootStart}(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)${separatorRun}`;
const knownPathEnd = String.raw`(?![\p{Script=Latin}\p{M}\p{Nd}_-]|[.%][\p{L}\p{N}])`;
const shellEscape = String.raw`\\[ !"#$&'()*;<>?[\]^\x60{|}~]`;
// A colon belongs to a name, as in `10:00:00/`, unless a line and column follow it to the end of the path, as in
// `x.ts:12:5` before a space or `)`; the digits are bounded, so the look ahead from each colon is short.
const restColon = String.raw`:(?!\d{1,9}(?::\d{1,9})?[)\]}>"',;]?(?:\s|$))`;
const restCharacter = String.raw`(?:[^\s\\/<>":]|${restColon}|${shellEscape})`;
const restInner = String.raw`(?:[^\\/<>":\n]|${restColon}|${shellEscape})`;
const knownPathRest = String.raw`(?:${separatorRun}(?:${restCharacter}(?:${restInner}*${restCharacter})?(?=[\\/])|${restCharacter}+))*[\\/]*`;
const shellEscapable = new Set(' !"#$&\'()*;<>?[]^`{|}~');

/** A Windows drive in each of the forms above. */
function driveRoot(drive: string): string {
  const letter = `[${drive.toUpperCase()}${drive.toLowerCase()}]`;
  return String.raw`(?:${letter}(?::|%3[Aa])|(?=[\\/])${rootStart}(?:${separatorRun}(?:mnt|cygdrive))?${separatorRun}${letter})${separatorRun}`;
}

/** Hex digits that match in either case. */
function hexPattern(hex: string): string {
  return hex.replace(/[a-f]/giu, (digit) => `[${digit.toUpperCase()}${digit.toLowerCase()}]`);
}

/**
 * A character of a known path as itself, percent-encoded, as a JSON `\u` escape for a character past ASCII or one of
 * `&<>`, and, unless it starts a segment, escaped with a backslash as a shell escapes it. A `%` followed by two hex
 * digits reads as an encoded character, so text has one reading.
 */
function characterPattern(character: string, first: boolean): string {
  if (character === '%') return '(?:%(?![0-9A-Fa-f]{2})|%25)';
  const literal = character.replace(/[\\^$.*+?()[\]{}|/]/u, '\\$&');
  const forms = [literal];
  if (!/^[\w.~-]$/u.test(character)) {
    const bytes = [...new TextEncoder().encode(character)];
    forms.push(bytes.map((byte) => `%${hexPattern(byte.toString(16).padStart(2, '0'))}`).join(''));
  }
  const code = character.codePointAt(0) ?? 0;
  if (code > 0x7e || '&<>'.includes(character)) {
    const units =
      code > 0xffff
        ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
        : [code];
    forms.push(
      units.map((unit) => `\\\\u${hexPattern(unit.toString(16).padStart(4, '0'))}`).join(''),
    );
  }
  if (!first && shellEscapable.has(character)) forms.push(`\\\\${literal}`);
  return forms.length === 1 ? literal : `(?:${forms.join('|')})`;
}

/** A known path as patterns in order: its root, then each character, with a separator run between segments. */
function knownPathTokens(knownPath: string): string[] | null {
  const parsed = /^(?:(~)|([A-Za-z]):)?[\\/]+(.+)$/su.exec(knownPath);
  const segments = parsed?.[3]?.split(/[\\/]+/u).filter(Boolean) ?? [];
  // A bare root, such as `/`, `C:\` or `~/`, would match every path, and a relative path names no place.
  if (!parsed || segments.length === 0) return null;
  const drive = parsed[2];
  const tokens = [parsed[1] ? homeRoot : drive ? driveRoot(drive) : posixRoot];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) tokens.push(separatorRun);
    for (const [position, character] of [...segment].entries()) {
      tokens.push(characterPattern(character, position === 0));
    }
  }
  return tokens;
}

interface PrefixTree {
  next: Map<string, PrefixTree>;
  end: boolean;
}

function addToTree(tree: PrefixTree, tokens: string[]): void {
  let node = tree;
  for (const token of tokens) {
    let child = node.next.get(token);
    if (!child) node.next.set(token, (child = { next: new Map(), end: false }));
    node = child;
  }
  node.end = true;
}

/**
 * The tree as a pattern. Where a known path ends, an empty branch comes after its longer continuations, so the longest
 * path wins, and the end test after the tree sends a failed match back to a shorter one. A run of nodes with one child
 * each is read in a loop, so only branches add to the call depth and a long path fits.
 */
function treePattern(node: PrefixTree): string {
  const branches = [...node.next].map(([token, child]) => {
    let pattern = token;
    let next = child;
    for (let only = singleChild(next); only; only = singleChild(next)) {
      pattern += only[0];
      next = only[1];
    }
    return pattern + treePattern(next);
  });
  if (node.end) branches.push('');
  return branches.length === 1 ? (branches[0] ?? '') : `(?:${branches.join('|')})`;
}

/** The one token and child that follow a node where no known path ends and nothing branches. */
function singleChild(node: PrefixTree): [string, PrefixTree] | undefined {
  return !node.end && node.next.size === 1 ? node.next.entries().next().value : undefined;
}

/** The index just past the quote that closes a quoted string, read as `quotedPath` reads it, or -1. */
function closingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') return -1;
    if (quote === "'") {
      if (character === "'") return index + 1;
    } else if (character === '\\') {
      if (quote === '\\"' && text[index + 1] === '"') return index + 2;
      index += 1;
    } else if (character === '"') {
      return quote === '"' ? index + 1 : -1;
    }
  }
  return -1;
}

/**
 * Replaces each known path that `pattern` finds. A match that opens with a quote runs to the quote that closes it after
 * the known path, which may hold a quote of its own, as in `O'Brien`; the replacement keeps the quotes. Without one, it
 * ends where the pattern ends.
 */
function replaceKnownPaths(text: string, pattern: RegExp): string {
  let result = '';
  let position = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const quote = match[1] ?? '';
    const pathEnd = match.index + quote.length + (match[2] ?? '').length;
    const close = quote ? closingQuote(text, pathEnd, quote) : -1;
    result += `${text.slice(position, match.index)}${quote}[LOCAL_PATH]${close >= 0 ? quote : ''}`;
    position = close >= 0 ? close : match.index + match[0].length;
    pattern.lastIndex = position;
  }
  return result + text.slice(position);
}

/** A quoted path's replacement, which keeps its quotes. */
function replaceQuoted(match: string): string {
  return match.startsWith('\\"') ? '\\"[LOCAL_PATH]\\"' : `${match[0]}[LOCAL_PATH]${match[0]}`;
}

/**
 * Replaces each private key block with a marker, in one pass. A key that the output limit cut off has no end line,
 * so everything from its first line on is replaced.
 */
function redactPrivateKeys(value: string): string {
  let result = '';
  let position = 0;
  keyBegin.lastIndex = 0;
  for (let begin = keyBegin.exec(value); begin; begin = keyBegin.exec(value)) {
    keyEnd.lastIndex = begin.index + begin[0].length;
    const end = keyEnd.exec(value);
    result += `${value.slice(position, begin.index)}[REDACTED PRIVATE KEY]`;
    position = end ? end.index + end[0].length : value.length;
    keyBegin.lastIndex = position;
  }
  return result + value.slice(position);
}

/** Removes credentials from text a tool printed or an agent wrote; paths and the rest stay. */
export function redactSecrets(value: string): string {
  let redacted = redactPrivateKeys(value).replace(
    secretAssignment,
    (match: string, name: string, quote: string, separator: string) => {
      const assigned = match.slice(name.length + quote.length + separator.length);
      const wrapper = assigned.startsWith('"') ? '"' : assigned.startsWith("'") ? "'" : '';
      return `${name}${quote}${separator}${wrapper}[REDACTED]${wrapper}`;
    },
  );
  for (const pattern of tokenValues) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted.replace(bearerValue, 'Bearer [REDACTED]');
}

/** Replaces the paths the general patterns recognize, quoted ones first. */
function replaceGeneralPaths(value: string): string {
  return value
    .replace(quotedPath, replaceQuoted)
    .replace(uncPath, '[LOCAL_PATH]')
    .replace(windowsPath, '[LOCAL_PATH]')
    .replace(privatePosixPath, '[LOCAL_PATH]')
    .replace(homeRelativePath, '[LOCAL_PATH]');
}

/** Text that may leave the machine in a strict-privacy packet: no credentials and no local paths. */
export function sanitizeForPacket(value: string): string {
  return replaceGeneralPaths(redactSecrets(value));
}

export interface PacketSanitizerOptions {
  /** Whether a known path matches in any letter case, as on the default Windows and macOS file systems. */
  caseInsensitive?: boolean;
}

/**
 * `sanitizeForPacket` that first replaces each of `knownPaths`, such as the workspace's roots and repositories, with
 * whatever follows it inside that path. It covers the paths the general patterns miss: those outside the prefixes they
 * list, those whose last segment holds a space, and those a credential assignment would cut at a space.
 */
export function createPacketSanitizer(
  knownPaths: readonly string[],
  {
    caseInsensitive = process.platform === 'win32' || process.platform === 'darwin',
  }: PacketSanitizerOptions = {},
): (value: string) => string {
  const sequences: string[][] = [];
  let total = 0;
  for (const knownPath of knownPaths) {
    if (knownPath.length > knownPathMaxLength) continue;
    // macOS may write a name composed or decomposed, so each known path goes in both ways.
    for (const form of new Set([knownPath.normalize('NFC'), knownPath.normalize('NFD')])) {
      const tokens = knownPathTokens(form);
      if (!tokens || total + form.length > knownPathsMaxLength) continue;
      sequences.push(tokens);
      total += form.length;
    }
  }
  const flags = caseInsensitive ? 'giu' : 'gu';
  const patterns: RegExp[] = [];
  let tree: PrefixTree = { next: new Map(), end: false };
  let length = 0;
  let separators = 0;
  const closeTree = () => {
    if (length === 0) return;
    // A quote right before a known path makes the match run to the closing quote.
    patterns.push(
      new RegExp(
        String.raw`((?<!\\)"|'|\\")?(${treePattern(tree)})${knownPathEnd}${knownPathRest}`,
        flags,
      ),
    );
    tree = { next: new Map(), end: false };
    length = 0;
    separators = 0;
  };
  for (const tokens of sequences.sort((left, right) => right.length - left.length)) {
    const tokensLength = tokens.reduce((sum, token) => sum + token.length, 0);
    const tokensSeparators = tokens.filter((token) => token === separatorRun).length + 1;
    if (
      length + tokensLength > treeMaxLength ||
      separators + tokensSeparators > treeMaxSeparators
    ) {
      closeTree();
    }
    addToTree(tree, tokens);
    length += tokensLength;
    separators += tokensSeparators;
  }
  closeTree();
  if (patterns.length === 0) return sanitizeForPacket;
  return (value) => {
    let text = value;
    for (const pattern of patterns) text = replaceKnownPaths(text, pattern);
    return sanitizeForPacket(text);
  };
}

/**
 * A command's arguments for a packet. Each one passes through `sanitize`, and the value after an option named for a
 * secret, as in `--token <value>`, is replaced whatever it looks like.
 */
export function sanitizeArgsForPacket(
  args: string[],
  sanitize: (value: string) => string = sanitizeForPacket,
): string[] {
  return args.map((arg, index) =>
    index > 0 && secretOption.test(args[index - 1] ?? '') ? '[REDACTED]' : sanitize(arg),
  );
}
