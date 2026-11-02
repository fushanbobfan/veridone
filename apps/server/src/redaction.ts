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
/** An assignment of a secret; `part`, when given, is an alternative tried first where a part of the value may start. */
function secretAssignmentPattern(part = ''): RegExp {
  const value = String.raw`(?:${part}[^\s"',;\\]|${escaped})(?:${part}${doubleQuoted}|${singleQuoted}|${escaped}|[^\s"',;\\])*|(?:${doubleQuoted}|${singleQuoted})(?:${part}${doubleQuoted}|${singleQuoted}|${escaped}|[^\s"',;\\)\]}>&|])*`;
  return new RegExp(
    String.raw`\b((?:[a-z0-9]{1,40}[_-]){0,6}(?:${secretWord}))(["']?)(\s*[:=]\s*)(?:${value})`,
    'giu',
  );
}
const secretAssignment = secretAssignmentPattern();
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
// that opens a word (`-I/x`), a local URL's host (`file://localhost/x`, `vscode://file/x`) or Vite's `/@fs` on a local
// host; a path inside a longer relative path or a remote URL stays. A separator never comes just before the start, so a
// run of separators is read once; a drive letter may follow anything, as in `/ID:\x`. The known path's last segment
// must end there: a Latin letter, digit, mark, `_` or `-` after it continues a longer name, so `importer` leaves
// `importer-v2` and `importeré` alone, while a Chinese character after it reads as prose. What follows a separator then
// belongs to the path, read at least as far as the general patterns read it, by the rules of Windows or POSIX below;
// after a quote, the match runs to the closing quote. The known paths share prefix trees, so a match attempt follows
// one path through a tree. The first character of a segment takes no shell escape, which a separator run could also
// claim, and a `%` has a second reading only where its encoded form cannot be mistaken for it, so no text can be read
// two ways and a failed attempt costs time in proportion to the path.
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
const rootStart = String.raw`(?:(?<![\w.\\/\]])|(?<=(?<![\w.\\/-])-{1,2}[A-Za-z][\w-]*)|(?<=file:\/\/localhost|vscode:\/\/file|\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/@fs))`;
const posixRoot = String.raw`(?=[\\/])${rootStart}${separatorRun}`;
const homeRoot = String.raw`(?=[~$%])${rootStart}(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)${separatorRun}`;
const knownPathEnd = String.raw`(?![\p{Script=Latin}\p{M}\p{Nd}_-]|[.%][\p{L}\p{N}])`;
// What follows a known path reads by the rules of the system its root is written for. A root written as Windows writes
// it, with a drive letter, a leading backslash, `%USERPROFILE%`, or `~` or `$HOME` and then a backslash, starts a
// Windows path: either slash separates, and a name may hold any character but `<>"`, those Windows keeps out of names
// included, so a path written right after it, as in `a;~/b?c`, goes with it. Any other root starts a POSIX path: only
// a slash separates, JSON-escaped or not; a backslash escapes the character after it, as a shell writes `a\ b`, and
// before any other character belongs to the name; an apostrophe opens a shell-quoted part when a closing one follows on
// the line, and is part of the name otherwise, as in `Bob's`; each reading excludes the other.
const windowsRoot =
  /^(?:[a-z](?::|%3a)|\\(?!\/)|%userprofile%|\$env:userprofile|(?:~|\$home|\$\{home\})\\(?!\/))/iu;
const escapable = String.raw` \x09!"#$&'()*;<>?[\]^\x60{|}~`;
const shellEscape = String.raw`\\[${escapable}]`;
// In a path's last segment a colon belongs to the name, as in `10:00:00`, unless a line and column follow it to the end,
// as in `x.ts:12:5` before a space or `)`; inside a segment that a separator follows, every colon does. The digits are
// bounded, so the look ahead from each colon is short.
const restColon = String.raw`:(?!\d{1,9}(?::\d{1,9})?[)\]}>"',;]?(?:\s|$))`;
const restQuote = String.raw`'[^'\n]*'|'(?![^'\n]*')`;

// The first pass puts a mark where it finds a known path, one mark for each kind, so the credential pass reads a value
// through the spaces of a known path, and the last pass replaces each mark with what follows it inside that path. In a
// credential value, the value's own rules read the quotes after a known path, as they read them without one: a quoted
// part joins the value, and a quote that does not close runs to the end of the line; a bearer value reads a marked
// path whole. A known path that ends in a credential's name and is assigned, as in `/work/token=x`, keeps that name
// after its mark, so the credential pass still sees the assignment. The marks are Unicode noncharacters, which the
// standard keeps for a program's own use; one already in the text reads as U+FFFD.
const posixMark = String.fromCharCode(0xfdd0);
const windowsMark = String.fromCharCode(0xfdd1);
const marks = posixMark + windowsMark;
const markInText = new RegExp(`[${marks}]`, 'gu');
const replacementCharacter = String.fromCharCode(0xfffd);

/**
 * What follows a separator after a known path, read as a Windows or a POSIX path. A mark ends it, since it stands for
 * the next known path. In a credential value, `inValue`, the value's own rules read each apostrophe and the separators
 * after the last segment, as they read them after any other character: a quote opens a quoted part and a backslash
 * escapes the character after it.
 */
function restPattern(windows: boolean, inValue = false): string {
  const apostrophe = inValue ? "'" : '';
  if (windows) {
    const name = String.raw`[^\s\\/<>:"${apostrophe}${marks}]`;
    const first = String.raw`(?:${name}|:)`;
    const inner = String.raw`[^\\/<>"${apostrophe}\n${marks}]`;
    const last = String.raw`(?:${name}|${restColon})`;
    const segments = String.raw`(?:${separatorRun}(?:${first}(?:${inner}*${first})?(?=[\\/])|${last}+))*`;
    return inValue ? segments : String.raw`${segments}[\\/]*`;
  }
  const slash = String.raw`(?:\\?\/)`;
  const backslash = String.raw`\\(?![\s${escapable}\/])`;
  const quote = inValue ? '' : `${restQuote}|`;
  const name = String.raw`(?:[^\s\\/<>"':${marks}]|${quote}${shellEscape}|${backslash})`;
  const first = String.raw`(?:${name}|:)`;
  const inner = String.raw`(?:[^\\/<>"'\n${marks}]|${quote}${shellEscape}|${backslash})`;
  const last = String.raw`(?:${name}|${restColon})`;
  const segments = String.raw`(?:${slash}+(?:${first}(?:${inner}*${first})?(?=${slash})|${last}+))*`;
  return inValue ? segments : `${segments}${slash}*`;
}
const shellEscapable = new Set(' !"#$&\'()*;<>?[]^`{|}~');
const valueRests = `${posixMark}${restPattern(false, true)}|${windowsMark}${restPattern(true, true)}`;
const secretAssignmentAfterMarks = secretAssignmentPattern(`${valueRests}|`);
const bearerAfterMarks = new RegExp(
  String.raw`\bBearer\s+(?=[A-Za-z0-9._~+/${marks}-]{8})(?:${valueRests}|[A-Za-z0-9._~+/-])+=*`,
  'gu',
);
const keptName = String.raw`(?:[\w.-]+(?=["']?\s*[:=]))?`;
const markedPath = new RegExp(
  String.raw`((?<!\\)"|'|\\")?(?:${posixMark}${keptName}${restPattern(false)}|${windowsMark}${keptName}${restPattern(true)})`,
  'gu',
);
const secretNameEnd = new RegExp(`(?:${secretWord})$`, 'iu');
const assignmentAhead = /["']?\s*[:=]/uy;

// Text past a million characters, which no packet field needs, is withheld whole: a pattern could exhaust V8's stack on
// such a text, and a sanitizer that throws would stop the export.
const readableLength = 1_000_000;
const withheld = '[REDACTED: text too long to sanitize]';

/** `sanitize(value)`, or the withheld marker for a text too long to read or one the patterns could not finish. */
function withinLimits(value: string, sanitize: (text: string) => string): string {
  if (value.length > readableLength) return withheld;
  try {
    return sanitize(value);
  } catch (error) {
    if (error instanceof RangeError) return withheld;
    throw error;
  }
}

/**
 * The mark of its kind for a known path the first pass found, with the credential's name the path ends in when it is
 * assigned.
 */
function markKnownPath(match: string, offset: number, text: string): string {
  const mark = windowsRoot.test(match) ? windowsMark : posixMark;
  assignmentAhead.lastIndex = offset + match.length;
  if (!assignmentAhead.test(text)) return mark;
  let start = match.length;
  while (start > 0 && /[\w.-]/u.test(match[start - 1] ?? '')) start -= 1;
  const name = match.slice(start);
  return secretNameEnd.test(name) ? `${mark}${name}` : mark;
}

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
 * `&<>`, and, unless it starts a segment, escaped with a backslash as a shell escapes it. `next` holds the name's two
 * characters after this one: a `%` followed by `25` in the name reads only as itself, since its encoded form `%25` could
 * then also be read as a `%` and `25`.
 */
function characterPattern(character: string, first: boolean, next: string): string {
  if (character === '%') return next === '25' ? '%' : '(?:%|%25)';
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
    const characters = [...segment];
    for (const [position, character] of characters.entries()) {
      const next = characters.slice(position + 1, position + 3).join('');
      tokens.push(characterPattern(character, position === 0, next));
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
 * Replaces each marked known path with what follows it inside that path. A mark right after a quote runs to the quote
 * that closes it, which the replacement keeps; the known path itself may have held a quote, as in `O'Brien`, which the
 * mark has taken. Without a quote, the replacement ends where the rest of the path ends.
 */
function replaceMarkedPaths(text: string): string {
  let result = '';
  let position = 0;
  markedPath.lastIndex = 0;
  for (let match = markedPath.exec(text); match; match = markedPath.exec(text)) {
    const quote = match[1] ?? '';
    const close = quote ? closingQuote(text, match.index + quote.length, quote) : -1;
    result += `${text.slice(position, match.index)}${quote}[LOCAL_PATH]${close >= 0 ? quote : ''}`;
    position = close >= 0 ? close : match.index + match[0].length;
    markedPath.lastIndex = position;
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
export function redactSecrets(
  value: string,
  assignment = secretAssignment,
  bearer = bearerValue,
): string {
  let redacted = redactPrivateKeys(value).replace(
    assignment,
    (match: string, name: string, quote: string, separator: string) => {
      const assigned = match.slice(name.length + quote.length + separator.length);
      const wrapper = assigned.startsWith('"') ? '"' : assigned.startsWith("'") ? "'" : '';
      return `${name}${quote}${separator}${wrapper}[REDACTED]${wrapper}`;
    },
  );
  for (const pattern of tokenValues) redacted = redacted.replace(pattern, '[REDACTED]');
  return redacted.replace(bearer, 'Bearer [REDACTED]');
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
  return withinLimits(value, (text) => replaceGeneralPaths(redactSecrets(text)));
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
    patterns.push(new RegExp(`(?:${treePattern(tree)})${knownPathEnd}`, flags));
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
  return (value) =>
    withinLimits(value, (text) => {
      let marked = text.replace(markInText, replacementCharacter);
      for (const pattern of patterns) marked = marked.replace(pattern, markKnownPath);
      return replaceGeneralPaths(
        replaceMarkedPaths(redactSecrets(marked, secretAssignmentAfterMarks, bearerAfterMarks)),
      );
    });
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
