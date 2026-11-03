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

export function getProvider(kind: MeetingProviderKind): MeetingProvider {
  switch (kind) {
    case 'fixed-link':
      return fixedLinkProvider;
    case 'zoom-api':
      // Option B isn't built yet; fall back so a break always starts.
      return fixedLinkProvider;
  }
}
