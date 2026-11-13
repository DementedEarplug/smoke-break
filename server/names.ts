// Display names: cleaned of invisible tricks, and compared so lookalikes collide.

export const NAME_MAX = 24;
/** Control, format (zero-width, bidi), surrogate, private-use and line/paragraph separator characters, plus blank-looking letters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀]/gu;

export function cleanName(s: unknown, fallback: string): string {
  if (typeof s !== 'string') return fallback;
  const cleaned = s.slice(0, 500).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  // Cut by code points so an emoji isn't split in half.
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim() || fallback;
}

/**
 * Common Latin lookalikes (Cyrillic, Greek, l/1/I, 0/O), after lowercasing.
 * Not a full confusables table; enough that "Alex" and "Аlex" can't coexist.
 */
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'i', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'y', χ: 'x',
  l: 'i', '1': 'i', '|': 'i', '0': 'o',
};

/** What two names are compared by: NFKC, case-folded, lookalikes merged. */
export function nameKey(name: string): string {
  const folded = name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
  return Array.from(folded, (c) => LOOKALIKES[c] ?? c).join('');
}

/** `name`, or `name 2`, `name 3`… : the first one whose key isn't in `taken`. */
export function uniqueName(taken: Set<string>, name: string): string {
  for (let n = 2, candidate = name; ; n++) {
    if (!taken.has(nameKey(candidate))) return candidate;
    const suffix = ` ${n}`;
    candidate = Array.from(name).slice(0, NAME_MAX - suffix.length).join('') + suffix;
  }
}
