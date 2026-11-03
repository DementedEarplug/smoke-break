// Types and constants shared by the client and the server.

export const MIN_LENGTH_MIN = 10;
export const MAX_LENGTH_MIN = 15;
export const DEFAULT_LENGTH_MIN = 12;
export const MINUTE_MS = 60_000;
/** How long an invite waits for a second person before "maybe later", in minutes. */
export const PENDING_TIMEOUT_MIN = 5;
/** How long the "out" phase lingers so clients can play the stub-out. */
export const OUT_LINGER_MS = 4_000;

export function clampLength(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_LENGTH_MIN;
  return Math.min(MAX_LENGTH_MIN, Math.max(MIN_LENGTH_MIN, Math.round(min)));
}

/** Idle is represented by `brk: null`. */
export type Phase = 'pending' | 'lighter' | 'lit' | 'out';
export type OutReason = 'burned' | 'nobody' | 'cancelled' | 'everyone-left';
export type MeetingProviderKind = 'fixed-link' | 'zoom-api';

export interface Participant {
  id: string;
  name: string;
  joinedAt: number;
  litAt: number | null;
}

export interface Break {
  id: string;
  phase: Phase;
  startedBy: string;
  startedByName: string;
  lengthMin: number;
  /** Length of a break "minute" in ms. Always 60s except in dev demo mode. */
  minuteMs: number;
  createdAt: number;
  pendingExpiresAt: number | null;
  litAt: number | null;
  endsAt: number | null;
  outAt: number | null;
  outReason: OutReason | null;
  /** Participants still in the break. Kept during "out" for the stub-out animation. */
  participants: Participant[];
  meetingRequested: boolean;
  meetingUrl: string | null;
}

export interface MemberView {
  /** Public id, not the member's private clientId. */
  id: string;
  name: string;
  online: boolean;
}

export interface TeamView {
  code: string;
  name: string;
  defaultLengthMin: number;
  zoomLink: string;
  meetingProvider: MeetingProviderKind;
  members: MemberView[];
  brk: Break | null;
}

export type ClientMsg =
  | { type: 'create'; teamName: string; clientId: string; name: string }
  | { type: 'hello'; teamCode: string; clientId: string; name: string }
  | { type: 'invite' }
  | { type: 'setLength'; lengthMin: number }
  | { type: 'join'; light?: boolean }
  | { type: 'light' }
  | { type: 'leave' }
  | { type: 'settings'; zoomLink?: string; defaultLengthMin?: number; teamName?: string };

export type ServerMsg =
  /** `you` is your public id: compare it with member and participant ids. */
  | { type: 'state'; team: TeamView; you: string; serverNow: number }
  | { type: 'error'; message: string; fatal?: boolean };
