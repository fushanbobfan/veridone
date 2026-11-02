// A name that ends in a secret word, written as an assignment, a header or a JSON field. The word must end the
// name, so `max_tokens` and `token_count` stay readable while `NPM_TOKEN` and `AWS_SECRET_ACCESS_KEY` lose their
// values. A quoted value is replaced up to its closing quote, past escaped quotes and escaped line breaks, or to the
// end of the line when the output was cut off before the quote closed. The name's prefix is bounded: check output
// comes from the commit under review, and an unbounded prefix takes quadratic time on input such as `a-a-a-…`.
const secretWord =
  'password|passwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?';
const secretAssignment = new RegExp(
  String.raw`\b((?:[a-z0-9]{1,40}[_-]){0,6}(?:${secretWord}))(["']?)(\s*[:=]\s*)(?:"(?:[^"\\\n]|\\\r\n|\\[\s\S])*"?|'(?:[^'\\\n]|\\\r\n|\\[\s\S])*'?|[^\s"',;]+)`,
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

// A path inside quotes runs to the closing quote, spaces, escaped quotes and the other kind of quote included, as JSON
// and shell quoting write it; these go first. An escaped quote starts no match, so each run is read once.
const pathStart = String.raw`(?:[A-Za-z]:[\\/]|\\{2,}[^\s\\<>:"|?*]|\/(?:Users|home|var|tmp|opt|etc|mnt|srv|root|Volumes|private|media)\/|~\/)`;
const quotedPath = new RegExp(
  String.raw`(?<!\\)(?:"${pathStart}(?:[^"\\\n<>|?*]|\\[\s\S])*"|'${pathStart}(?:[^'\\\n<>|?*]|\\[\s\S])*')`,
  'gu',
);
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

/** Text that may leave the machine in a strict-privacy packet: no credentials and no local paths. */
export function sanitizeForPacket(value: string): string {
  return redactSecrets(value)
    .replace(quotedPath, (match) => `${match[0]}[LOCAL_PATH]${match[0]}`)
    .replace(uncPath, '[LOCAL_PATH]')
    .replace(windowsPath, '[LOCAL_PATH]')
    .replace(privatePosixPath, '[LOCAL_PATH]')
    .replace(homeRelativePath, '[LOCAL_PATH]');
}

/**
 * A command's arguments for a packet. Each one passes through the text rules, and the value after an option named for
 * a secret, as in `--token <value>`, is replaced whatever it looks like.
 */
export function sanitizeArgsForPacket(args: string[]): string[] {
  return args.map((arg, index) =>
    index > 0 && secretOption.test(args[index - 1] ?? '') ? '[REDACTED]' : sanitizeForPacket(arg),
  );
}
