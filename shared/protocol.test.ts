import { describe, expect, it } from 'vitest';
import { parseServerMsg } from './protocol.ts';

describe('parseServerMsg', () => {
  it.each([
    ['not json', null],
    ['null', null],
    ['42', null],
    ['{"type":"nope"}', null],
    ['{"type":"error"}', null],
    ['{"type":"state","you":"x","serverNow":1}', null],
    ['{"type":"state","you":"x","serverNow":"1","team":{"code":"A","members":[]}}', null],
  ])('rejects %s', (raw, out) => expect(parseServerMsg(raw)).toBe(out));

  it('accepts real messages', () => {
    expect(parseServerMsg('{"type":"error","message":"no"}')).toEqual({ type: 'error', message: 'no' });
    const state = { type: 'state', you: 'x', serverNow: 1, team: { code: 'A', members: [] } };
    expect(parseServerMsg(JSON.stringify(state))).toEqual(state);
  });

  it('ignores non-text frames', () => expect(parseServerMsg(new ArrayBuffer(2))).toBeNull());
});
