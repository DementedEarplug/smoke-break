// When the pack opens the break's call. Kept free of DOM so it can be unit tested.
//
// The hub only sends the meeting link to people taking part in the break, so a
// late joiner gets it in the first state after the hub has accepted the join,
// not before. Every path that opens the call waits for that.

import { type TeamView, normalizeMeetingLink } from '../../shared/protocol.ts';

/** How long the freshly lit cigarette shows before the call opens. */
export const LIT_PAUSE_MS = 700;
/** Open the call anyway if the animation never gets there (e.g. a slow server). */
export const MAX_LIGHT_WAIT_MS = 4000;
/** A late joiner gives the hub this long to accept the join before giving up on opening the call. */
export const JOIN_WAIT_MS = 10_000;

/**
 * The break's meeting link in canonical form, if it's one we're willing to
 * open. Only this output is ever opened, never the hub's raw string.
 */
export function safeMeetingUrl(team: TeamView | null): string | null {
  return normalizeMeetingLink(team?.brk?.meetingUrl) || null;
}

/** Taking part in a break that is still on. */
export function isParticipant(team: TeamView | null, me: string): boolean {
  const b = team?.brk;
  return !!b && b.phase !== 'out' && b.participants.some((p) => p.id === me);
}

/** After a click that lights up (or joins and lights up): waiting to open the call. */
export interface LightWait {
  /** When the click happened. */
  since: number;
  /** When we were first seen taking part (a late joiner isn't until the hub accepts). */
  joinedAt: number | null;
  /** When our cigarette was first drawn lit. */
  litSeen: number | null;
}

export const startLightWait = (now: number): LightWait => ({ since: now, joinedAt: null, litSeen: null });

/** One frame of the wait: keep waiting, open the call now, or give up. Updates `wait`. */
export function lightWaitStep(
  wait: LightWait,
  now: number,
  seen: { participant: boolean; lit: boolean },
): 'wait' | 'open' | 'cancel' {
  if (!seen.participant) {
    // Left again, or the hub never took the join (break over, refused).
    if (wait.joinedAt !== null || now - wait.since >= JOIN_WAIT_MS) return 'cancel';
    return 'wait';
  }
  wait.joinedAt ??= now;
  if (wait.litSeen === null && seen.lit) wait.litSeen = now;
  const pauseDone = wait.litSeen !== null && now - wait.litSeen >= LIT_PAUSE_MS;
  return pauseDone || now - wait.joinedAt >= MAX_LIGHT_WAIT_MS ? 'open' : 'wait';
}

/** What opening the call means right now. */
export function meetingTarget(team: TeamView | null): { url: string } | 'no-link' | 'later' {
  const url = safeMeetingUrl(team);
  if (url) return { url };
  // Only the owner receives the team's link itself, so ask `hasZoomLink`.
  if (team?.meetingProvider === 'fixed-link' && !team.hasZoomLink) return 'no-link';
  // Being created (Zoom API), or not here yet: the hub sends it once it has
  // accepted our join.
  return 'later';
}

/**
 * The call was promised but its link hadn't arrived. On each new state: open
 * it now, keep waiting, or drop the promise (we're no longer in this break, so
 * a link that turns up later must not pop a call open).
 */
export function pendingLinkStep(team: TeamView, me: string): { url: string } | 'wait' | 'drop' {
  if (!isParticipant(team, me)) return 'drop';
  const url = safeMeetingUrl(team);
  return url ? { url } : 'wait';
}
