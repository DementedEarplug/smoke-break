// How the owner tells people apart in the roster and the waiting list. Kept
// free of DOM so it can be unit tested.

import type { MemberView } from '../shared/protocol.ts';

/** Public ids are long; this much tells people with the same name apart. */
export const shortId = (id: string) => id.slice(0, 6);

/**
 * What two names look alike by, here: trimmed, width/compatibility forms
 * folded (NFKC) and case-folded. The hub merges more lookalikes than this when
 * it hands out names; this is only to point out the ones that still collide.
 */
export function displayKey(name: string): string {
  return name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Ids of the entries whose names look the same as another entry's, across the
 * roster and the waiting list together (a waiting "alex" next to a member
 * "Alex" is exactly the case to point out).
 */
export function lookalikeIds(...lists: MemberView[][]): Set<string> {
  const byKey = new Map<string, string[]>();
  for (const m of lists.flat()) {
    const key = displayKey(m.name);
    const ids = byKey.get(key);
    if (ids) ids.push(m.id);
    else byKey.set(key, [m.id]);
  }
  const out = new Set<string>();
  for (const ids of byKey.values()) if (ids.length > 1) for (const id of ids) out.add(id);
  return out;
}

/**
 * What to show next to a name: the access-token label when there is one (that
 * is who they really are; the name is just what they typed), and the start of
 * their id where the label alone can't tell them apart: in the waiting list
 * without a label, or when their name looks like someone else's.
 */
export function whoTags(m: MemberView, opts: { lookalike: boolean; waiting: boolean }): { label?: string; id?: string } {
  const out: { label?: string; id?: string } = {};
  if (m.label) out.label = m.label;
  // Two devices of one person share a label, so a lookalike gets the id too.
  if (opts.lookalike || (opts.waiting && !m.label)) out.id = shortId(m.id);
  return out;
}
