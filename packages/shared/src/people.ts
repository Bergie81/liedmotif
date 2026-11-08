/**
 * Build the stable key used for Person-name uniqueness and matching.
 * Compatibility normalization handles presentation variants; the two explicit
 * replacements complete the case-fold distinctions JavaScript lowercasing
 * preserves for German sharp-s and Greek final sigma.
 */
export function canonicalPersonName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replaceAll('ς', 'σ');
}

export interface MatchablePerson {
  id: string;
  name: string;
  nameMatchKey?: string;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PersonNameSpan<T> {
  person: T;
  personIndex: number;
  start: number;
  end: number;
}

function resolvedPersonNameSpans<T extends MatchablePerson>(
  canonicalContext: string,
  people: readonly T[],
): PersonNameSpan<T>[] {
  const candidates = people.flatMap((person, personIndex) => {
    const key = person.nameMatchKey || canonicalPersonName(person.name);
    if (!key) return [];
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}\\p{M}])(${escapedPattern(key)})(?=$|[^\\p{L}\\p{N}\\p{M}])`,
      'gu',
    );
    return [...canonicalContext.matchAll(pattern)].map((match) => {
      const prefixLength = match[1]?.length ?? 0;
      const start = (match.index ?? 0) + prefixLength;
      return { person, personIndex, start, end: start + (match[2]?.length ?? 0) };
    });
  });
  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      right.end - right.start - (left.end - left.start) ||
      left.personIndex - right.personIndex,
  );
  const resolved: PersonNameSpan<T>[] = [];
  for (const candidate of candidates) {
    if (resolved.some((span) => candidate.start < span.end && candidate.end > span.start)) continue;
    resolved.push(candidate);
  }
  return resolved;
}

/** Match only configured names as complete Unicode words or phrases. */
export function matchConfiguredPeople<T extends MatchablePerson>(
  context: string,
  people: readonly T[],
): T[] {
  const canonicalContext = canonicalPersonName(context);
  const matchedIndexes = new Set(
    resolvedPersonNameSpans(canonicalContext, people).map((span) => span.personIndex),
  );
  return people.filter((_person, index) => matchedIndexes.has(index));
}

/** Replace exact configured names using the same canonical matching semantics. */
export function replaceConfiguredPersonNames<T extends MatchablePerson>(
  context: string,
  people: readonly T[],
  replacement: (person: T, index: number) => string,
): string {
  let result = canonicalPersonName(context);
  const spans = resolvedPersonNameSpans(result, people).toSorted(
    (left, right) => right.start - left.start,
  );
  for (const span of spans) {
    result =
      result.slice(0, span.start) +
      replacement(span.person, span.personIndex) +
      result.slice(span.end);
  }
  return result;
}
