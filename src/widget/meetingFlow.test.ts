import { describe, expect, it } from 'vitest';
import type { Break, TeamView } from '../../shared/protocol.ts';
import {
  JOIN_WAIT_MS,
  LIT_PAUSE_MS,
  MAX_LIGHT_WAIT_MS,
  isParticipant,
  lightWaitStep,
  meetingTarget,
  pendingLinkStep,
  startLightWait,
} from './meetingFlow.ts';

const LINK = 'https://zoom.us/j/123?pwd=x';

const brk = (patch: Partial<Break> = {}): Break => ({
  id: 'b1',
  phase: 'lit',
  startedBy: 'sam',
  startedByName: 'Sam',
  lengthMin: 12,
  minuteMs: 60_000,
  createdAt: 0,
  pendingExpiresAt: null,
  litAt: 1,
  endsAt: 720_000,
  outAt: null,
  outReason: null,
  participants: [{ id: 'sam', name: 'Sam', joinedAt: 0, litAt: 1 }],
  meetingRequested: true,
  // What a non-participant gets now.
  meetingUrl: null,
  ...patch,
});

const team = (b: Break | null, patch: Partial<TeamView> = {}): TeamView => ({
  code: 'ABCDE23456',
  name: 'T',
  defaultLengthMin: 12,
  zoomLink: '',
  hasZoomLink: true,
  meetingProvider: 'fixed-link',
  ownerId: 'sam',
  members: [],
  requireApproval: false,
  pending: [],
  brk: b,
  ...patch,
});

/** The state a late joiner gets once the hub has taken the join: in the break, with the link. */
const joined = (url: string | null = LINK) =>
  team(
    brk({
      participants: [
        { id: 'sam', name: 'Sam', joinedAt: 0, litAt: 1 },
        { id: 'me', name: 'Me', joinedAt: 5, litAt: 5 },
      ],
      meetingUrl: url,
    }),
  );

describe('late join + light', () => {
  it('waits for the hub to take the join, then for the light-up, then opens', () => {
    const wait = startLightWait(0);
    // Before the hub answers: not a participant, no link. Keep waiting (this used to give up).
    expect(lightWaitStep(wait, 16, { participant: false, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, 1500, { participant: false, lit: false })).toBe('wait');
    // Accepted.
    expect(lightWaitStep(wait, 1600, { participant: true, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, 1700, { participant: true, lit: true })).toBe('wait');
    expect(lightWaitStep(wait, 1700 + LIT_PAUSE_MS, { participant: true, lit: true })).toBe('open');
  });

  it('counts the slow-animation fallback from when the join was taken, not from the click', () => {
    const wait = startLightWait(0);
    expect(lightWaitStep(wait, 3900, { participant: false, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, 4000, { participant: true, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, 4000 + MAX_LIGHT_WAIT_MS - 1, { participant: true, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, 4000 + MAX_LIGHT_WAIT_MS, { participant: true, lit: false })).toBe('open');
  });

  it('gives up if the hub never takes the join', () => {
    const wait = startLightWait(0);
    expect(lightWaitStep(wait, JOIN_WAIT_MS - 1, { participant: false, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, JOIN_WAIT_MS, { participant: false, lit: false })).toBe('cancel');
  });

  it('gives up if we leave again before it opens', () => {
    const wait = startLightWait(0);
    expect(lightWaitStep(wait, 100, { participant: true, lit: false })).toBe('wait');
    expect(lightWaitStep(wait, 200, { participant: false, lit: false })).toBe('cancel');
  });
});

describe('light as a participant', () => {
  it('opens after the lit pause', () => {
    const wait = startLightWait(0);
    expect(lightWaitStep(wait, 16, { participant: true, lit: true })).toBe('wait');
    expect(lightWaitStep(wait, 16 + LIT_PAUSE_MS, { participant: true, lit: true })).toBe('open');
  });
});

describe('meetingTarget', () => {
  it('opens the link when we have it', () => {
    expect(meetingTarget(joined())).toEqual({ url: LINK });
  });

  it('waits for the link when the team has one but it has not reached us yet', () => {
    expect(meetingTarget(joined(null))).toBe('later');
    expect(meetingTarget(team(brk(), { meetingProvider: 'zoom-api', hasZoomLink: false }))).toBe('later');
  });

  it('says so when the team has no link at all', () => {
    expect(meetingTarget(team(brk(), { hasZoomLink: false }))).toBe('no-link');
  });

  it('never opens a link we would refuse', () => {
    expect(meetingTarget(joined('https://zoom.us/signin'))).toBe('later');
    expect(meetingTarget(joined('https://evil.example/j/1'))).toBe('later');
  });
});

describe('pendingLinkStep (the call was promised before its link arrived)', () => {
  it('keeps waiting while we take part and the link is not here', () => {
    expect(pendingLinkStep(joined(null), 'me')).toBe('wait');
  });

  it('opens once the state with the link arrives', () => {
    expect(pendingLinkStep(joined(), 'me')).toEqual({ url: LINK });
  });

  it('drops the promise once we are out of the break', () => {
    expect(pendingLinkStep(team(brk()), 'me')).toBe('drop');
    expect(pendingLinkStep(team(null), 'me')).toBe('drop');
    expect(pendingLinkStep(team(brk({ ...joined().brk!, phase: 'out' })), 'me')).toBe('drop');
  });

  it("doesn't open a link an older hub sends to people outside the break", () => {
    expect(pendingLinkStep(team(brk({ meetingUrl: LINK })), 'me')).toBe('drop');
  });
});

describe('isParticipant', () => {
  it('is true only while in a break that is on', () => {
    expect(isParticipant(joined(), 'me')).toBe(true);
    expect(isParticipant(joined(), 'other')).toBe(false);
    expect(isParticipant(null, 'me')).toBe(false);
  });
});
