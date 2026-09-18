export function unretainedIds(
  candidateIds: Iterable<string>,
  retainedIds: ReadonlySet<string>,
): string[] {
  return [...candidateIds].filter((id) => !retainedIds.has(id));
}

export function boundedExpiredIds(
  entries: Iterable<readonly [string, { createdAt: number }]>,
  now: number,
  ttlMs: number,
  maximumEntries: number,
): string[] {
  const ordered = [...entries].sort(
    ([, left], [, right]) => left.createdAt - right.createdAt,
  );
  const expired = ordered
    .filter(([, value]) => now - value.createdAt >= ttlMs)
    .map(([id]) => id);
  const remaining = ordered.filter(([id]) => !expired.includes(id));
  const overflow = Math.max(0, remaining.length - maximumEntries);
  return [...expired, ...remaining.slice(0, overflow).map(([id]) => id)];
}
