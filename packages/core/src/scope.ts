export interface ScopeAssessment {
  declared: boolean;
  changedPaths: string[];
  outsidePaths: string[];
  satisfied: boolean;
}

export function pathFromStatusEntry(entry: string): string {
  const withoutStatus = /^[ MADRCU?!]{2} /u.test(entry) ? entry.slice(3).trim() : entry.trim();
  const renamedTarget = withoutStatus.includes(' -> ')
    ? (withoutStatus.split(' -> ').at(-1) ?? withoutStatus)
    : withoutStatus;
  return renamedTarget.replaceAll('\\', '/').replace(/^\.\//u, '');
}

export function assessDeclaredScope(
  statusEntries: string[],
  declaredPrefixes: string[],
): ScopeAssessment {
  const prefixes = [
    ...new Set(
      declaredPrefixes
        .map((value) => value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, ''))
        .filter(Boolean),
    ),
  ];
  const changedPaths = [...new Set(statusEntries.map(pathFromStatusEntry).filter(Boolean))];
  const outsidePaths =
    prefixes.length === 0
      ? []
      : changedPaths.filter(
          (changedPath) =>
            !prefixes.some(
              (prefix) => changedPath === prefix || changedPath.startsWith(`${prefix}/`),
            ),
        );
  return {
    declared: prefixes.length > 0,
    changedPaths,
    outsidePaths,
    satisfied: prefixes.length === 0 || outsidePaths.length === 0,
  };
}
