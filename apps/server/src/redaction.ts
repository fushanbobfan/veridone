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
/** A quoted path whose text begins with `start`, up to its closing quote. */
function quotedPattern(start: string, flags = 'gu'): RegExp {
  return new RegExp(
    String.raw`(?<!\\)"${start}(?:[^"\\\n]|\\[\s\S])*"|'${start}[^'\n]*'|\\"${start}(?:[^"\\\n]|\\(?!")[\s\S])*\\"`,
    flags,
  );
}
const quotedPath = quotedPattern(pathStart);
// Outside quotes, separators may repeat, as in JSON-escaped Windows paths (`C:\\Users\\…`). A segment holds spaces
// inside it when another separator follows, as in `C:\Program Files\` or `/home/Bob Smith/`; the last segment ends at
// the first space, so the prose after a path stays. Privacy comes first: words between a path and a later slash on the
// same line, as in `/home/page and verify pass/fail`, go with the path. Each alternative either ends at a separator or
// cannot hold a space, so a segment is read once: the patterns take linear time.
const windowsPath =
  /\b[A-Za-z]:[\\/]+(?:(?:[^\s\\/<>:"|?*](?:[^\\/<>:"|?*\n]*[^\s\\/<>:"|?*])?(?=[\\/])|[^\s\\/<>:"|?*]+)[\\/]*)*/gu;
const uncPath =
  /(?<![\w\\:])\\{2,}[^\s\\<>:"|?*]+(?:\\+(?:[^\s\\<>:"|?*](?:[^\\<>:"|?*\n]*[^\s\\<>:"|?*])?(?=\\)|[^\s\\<>:"|?*]+))+\\*/gu;
const privatePosixPath =
  /(?<![\w.])\/(?:Users|home|var|tmp|opt|etc|mnt|srv|root|Volumes|private|media)(?:\/+(?:[^\s/<>'"](?:[^/<>'"\n]*[^\s/<>'"])?(?=\/)|[^\s/<>'"]+))+\/?/gu;
const homeRelativePath =
  /(?<![\w/])~(?:\/+(?:[^\s/<>'"](?:[^/<>'"\n]*[^\s/<>'"])?(?=\/)|[^\s/<>'"]+))+\/?/gu;

// A known local path, such as a workspace root or the user's home, matches exactly, in each way text writes it: with
// separators of either kind, repeated as JSON escapes them (`D:/x`, `D:\x`, `D:\\x`); with characters percent-encoded,
// as a file URL writes them, and a space escaped with a backslash, as a shell writes it; and with a Windows drive named
// as a POSIX shell on Windows names it (`/d/x`, `/mnt/d/x`, `/cygdrive/d/x`). A match from a POSIX root starts where no
// word character, period or separator comes before it, so a run of separators is read once; a drive letter needs only
// no word character before it, as in `file:///D:/x`. Outside quotes, the known path's last segment must end where an
// ASCII name could not go on, so `importer` does not match `importer-v2`; what follows a separator then belongs to the
// path by the segment rule above, up to a colon, so a `:12:5` position stays. In quotes, the match runs to the closing
// quote. The known paths share a prefix tree, so a match attempt follows a single path through it and does not try
// each known path in turn.
//
// V8 compiles a regular expression on first use and refuses one past a size limit, or a sequence long enough to
// exhaust its stack. A known path longer than 4,096 characters, Linux's limit for a path, is left to the general
// patterns, and the rest go into trees of bounded size, longest paths first, so a longer path still wins over its
// prefix.
const knownPathMaxLength = 4_096;
const treeBudget = 100_000;
const separatorRun = String.raw`[\\/]+`;
const knownPathEnd = String.raw`(?![\w-]|[.%][A-Za-z0-9])`;
const knownPathRest = String.raw`(?:[\\/]+(?:[^\s\\/<>"'\x60|?*:](?:[^\\/<>"'\x60|?*:\n]*[^\s\\/<>"'\x60|?*:])?(?=[\\/])|[^\s\\/<>"'\x60|?*:]+))*[\\/]*`;

/** Where a known path starts: a POSIX root, or a Windows drive in any of the forms above. */
function rootPattern(drive: string | undefined): string {
  if (!drive) return String.raw`(?<![\w.\\/])${separatorRun}`;
  const letter = `[${drive.toUpperCase()}${drive.toLowerCase()}]`;
  return String.raw`(?:(?<!\w)${letter}:|(?<![\w.\\/])(?:\/(?:mnt|cygdrive))?\/${letter})${separatorRun}`;
}

/** A character of a known path as itself or percent-encoded, and a space also as a shell escapes it. */
function characterPattern(character: string): string {
  const literal = character.replace(/[\\^$.*+?()[\]{}|/]/u, '\\$&');
  const forms = [literal];
  try {
    const encoded = encodeURIComponent(character);
    if (encoded !== character) forms.push(encoded);
  } catch {
    // A lone surrogate has no percent-encoding.
  }
  if (character === ' ') forms.push(String.raw`\\ `);
  return forms.length === 1 ? literal : `(?:${forms.join('|')})`;
}

/** A known path as patterns in order: its root, then each character, with a separator run between segments. */
function knownPathTokens(knownPath: string): string[] | null {
  const parsed = /^(?:([A-Za-z]):)?[\\/]+(.+)$/su.exec(knownPath);
  const segments = parsed?.[2]?.split(/[\\/]+/u).filter(Boolean) ?? [];
  // A bare root, such as `/` or `C:\`, would match every path, and a relative path names no place.
  if (!parsed || segments.length === 0) return null;
  const tokens = [rootPattern(parsed[1])];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) tokens.push(separatorRun);
    for (const character of segment) tokens.push(characterPattern(character));
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
 * The tree as a pattern. A known path's `end` comes after its longer continuations, so the longest path wins. A run
 * of nodes with one child each is read in a loop, so only branches add to the call depth and a long path fits.
 */
function treePattern(node: PrefixTree, end: string): string {
  const branches = [...node.next].map(([token, child]) => {
    let pattern = token;
    let next = child;
    for (let only = singleChild(next); only; only = singleChild(next)) {
      pattern += only[0];
      next = only[1];
    }
    return pattern + treePattern(next, end);
  });
  if (node.end) branches.push(end);
  return branches.length === 1 ? (branches[0] ?? '') : `(?:${branches.join('|')})`;
}

/** The one token and child that follow a node where no known path ends and nothing branches. */
function singleChild(node: PrefixTree): [string, PrefixTree] | undefined {
  return !node.end && node.next.size === 1 ? node.next.entries().next().value : undefined;
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
 * `sanitizeForPacket` that also replaces each of `knownPaths`, such as the workspace's roots and repositories, with
 * whatever follows it inside that path. It covers the paths the general patterns miss: those outside the prefixes they
 * list, and those whose last segment holds a space.
 */
export function createPacketSanitizer(
  knownPaths: readonly string[],
  {
    caseInsensitive = process.platform === 'win32' || process.platform === 'darwin',
  }: PacketSanitizerOptions = {},
): (value: string) => string {
  const sequences: string[][] = [];
  for (const knownPath of knownPaths) {
    if (knownPath.length > knownPathMaxLength) continue;
    // macOS may write a name composed or decomposed, so each known path goes in both ways.
    for (const form of new Set([knownPath.normalize('NFC'), knownPath.normalize('NFD')])) {
      const tokens = knownPathTokens(form);
      if (tokens) sequences.push(tokens);
    }
  }
  const flags = caseInsensitive ? 'giu' : 'gu';
  const passes: Array<{ quoted: RegExp; unquoted: RegExp }> = [];
  let tree: PrefixTree = { next: new Map(), end: false };
  let size = 0;
  const closeTree = () => {
    if (size === 0) return;
    passes.push({
      quoted: quotedPattern(treePattern(tree, ''), flags),
      unquoted: new RegExp(`${treePattern(tree, knownPathEnd)}${knownPathRest}`, flags),
    });
    tree = { next: new Map(), end: false };
    size = 0;
  };
  for (const tokens of sequences.sort((left, right) => right.length - left.length)) {
    const length = tokens.reduce((sum, token) => sum + token.length, 0);
    if (size + length > treeBudget) closeTree();
    addToTree(tree, tokens);
    size += length;
  }
  closeTree();
  if (passes.length === 0) return sanitizeForPacket;
  return (value) => {
    let text = redactSecrets(value);
    for (const { quoted, unquoted } of passes) {
      text = text.replace(quoted, replaceQuoted).replace(unquoted, '[LOCAL_PATH]');
    }
    return replaceGeneralPaths(text);
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
