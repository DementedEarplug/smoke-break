import { describe, expect, it } from 'vitest';
import { checkServerUrl, hubKey } from './serverUrl.ts';

describe('hubKey', () => {
  it('files spellings of the same hub together', () => {
    const key = 'wss://breaks.example.com/ws';
    for (const raw of [
      'wss://breaks.example.com/ws',
      ' WSS://Breaks.Example.com/ws ',
      'wss://breaks.example.com:443/ws',
      'wss://breaks.example.com/ws#x',
    ]) {
      expect(hubKey(raw)).toBe(key);
    }
  });

  it('keeps different hubs apart', () => {
    const keys = new Set(
      [
        'wss://breaks.example.com/ws',
        'wss://breaks.example.com:8443/ws',
        'wss://breaks.example.com/other',
        'wss://evil.example/ws',
        'ws://localhost:8787/ws',
        'ws://localhost:8788/ws',
      ].map(hubKey),
    );
    expect(keys.size).toBe(6);
  });

  it('agrees with the address the app connects to', () => {
    const r = checkServerUrl(' WSS://Breaks.Example.com:443/ws ');
    expect('url' in r && hubKey(r.url)).toBe(hubKey('wss://breaks.example.com/ws'));
  });
});

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
