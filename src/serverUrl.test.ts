import { describe, expect, it } from 'vitest';
import { checkServerUrl } from './serverUrl.ts';

describe('checkServerUrl', () => {
  it.each([
    ['wss://breaks.example.com/ws', 'wss://breaks.example.com/ws'],
    ['  wss://breaks.example.com:8443/ws ', 'wss://breaks.example.com:8443/ws'],
    ['WSS://Breaks.Example.com/ws', 'wss://breaks.example.com/ws'],
    ['ws://localhost:8787/ws', 'ws://localhost:8787/ws'],
    ['ws://127.0.0.1:8787/ws', 'ws://127.0.0.1:8787/ws'],
    ['ws://[::1]:8787/ws', 'ws://[::1]:8787/ws'],
  ])('accepts %s', (raw, url) => expect(checkServerUrl(raw)).toEqual({ url }));

  it.each([
    'ws://breaks.example.com/ws',
    'ws://192.168.1.20:8787/ws',
    'ws://localhost.evil.example/ws',
    'ws://127.0.0.1.nip.io/ws',
    'ws://localhost@evil.example/ws',
    'wss://user:pw@breaks.example.com/ws',
    'wss://breaks.example.com\\@evil.example/ws',
    'wss://breaks.example.com/w s',
    'https://breaks.example.com/ws',
    'http://localhost:8787/ws',
    'breaks.example.com/ws',
    '',
  ])('rejects %j with a message', (raw) => {
    const r = checkServerUrl(raw);
    expect('error' in r && r.error.length > 0).toBe(true);
  });

  it('explains the ws:// rule', () => {
    expect(checkServerUrl('ws://breaks.example.com/ws')).toEqual({
      error: expect.stringContaining('wss://'),
    });
  });
});
