// Meeting providers. The rest of the app only calls startMeeting/endMeeting;
// which provider runs is a per-team setting.

import type { MeetingProviderKind } from '../shared/protocol.ts';

export interface MeetingContext {
  teamCode: string;
  breakId: string;
  zoomLink: string;
}

export interface MeetingProvider {
  /** Returns a join link, or null if none is configured. */
  startMeeting(ctx: MeetingContext): Promise<string | null>;
  endMeeting(ctx: MeetingContext): Promise<void>;
}

/** Option A: everyone opens the team's recurring link; people leave the call themselves. */
export const fixedLinkProvider: MeetingProvider = {
  async startMeeting(ctx) {
    return ctx.zoomLink || null;
  },
  async endMeeting() {},
};

let warnedZoomApi = false;

export function getProvider(kind: MeetingProviderKind): MeetingProvider {
  switch (kind) {
    case 'fixed-link':
      return fixedLinkProvider;
    case 'zoom-api':
      // Option B isn't built yet; fall back so a break always starts, but say so.
      // When it is: keep API credentials in the environment, never in teams.json.
      if (!warnedZoomApi) {
        warnedZoomApi = true;
        console.warn('[smoke-break] zoom-api meetings are not implemented yet; using the fixed link.');
      }
      return fixedLinkProvider;
  }
}
