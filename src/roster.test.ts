import { describe, expect, it } from 'vitest';
import type { MemberView } from '../shared/protocol.ts';
import { displayKey, lookalikeIds, shortId, whoTags } from './roster.ts';

const m = (id: string, name: string, label?: string): MemberView => (label ? { id, name, online: true, label } : { id, name, online: true });

describe('displayKey', () => {
  it('folds case, width and surrounding space', () => {
    expect(displayKey('  Alex ')).toBe(displayKey('alex'));
    expect(displayKey('ＡＬＥＸ')).toBe(displayKey('alex'));
    expect(displayKey('Straße')).toBe(displayKey('STRASSE'));
    expect(displayKey('Al  ex')).toBe(displayKey('al ex'));
    expect(displayKey('Alex')).not.toBe(displayKey('Alexa'));
  });
});

describe('lookalikeIds', () => {
  it('marks every entry whose name looks like another, across roster and waiting list', () => {
    const roster = [m('aaaaaa1', 'Alex'), m('bbbbbb1', 'Sam')];
    const waiting = [m('cccccc1', ' alex'), m('dddddd1', 'Kim')];
    expect(lookalikeIds(roster, waiting)).toEqual(new Set(['aaaaaa1', 'cccccc1']));
  });

  it('marks nobody when all names differ', () => {
    expect(lookalikeIds([m('a', 'Alex'), m('b', 'Sam')], [])).toEqual(new Set());
  });
});

describe('whoTags', () => {
  it('shows the label when there is one', () => {
    expect(whoTags(m('abcdefgh', 'Alex', 'alex.k'), { lookalike: false, waiting: false })).toEqual({ label: 'alex.k' });
    expect(whoTags(m('abcdefgh', 'Alex', 'alex.k'), { lookalike: false, waiting: true })).toEqual({ label: 'alex.k' });
  });

  it('keeps the short id in the waiting list without a label', () => {
    expect(whoTags(m('abcdefgh', 'Alex'), { lookalike: false, waiting: true })).toEqual({ id: 'abcdef' });
    expect(whoTags(m('abcdefgh', 'Alex'), { lookalike: false, waiting: false })).toEqual({});
  });

  it('adds the short id to lookalikes, labelled or not', () => {
    expect(whoTags(m('abcdefgh', 'Alex'), { lookalike: true, waiting: false })).toEqual({ id: 'abcdef' });
    expect(whoTags(m('abcdefgh', 'Alex', 'alex.k'), { lookalike: true, waiting: false })).toEqual({ label: 'alex.k', id: 'abcdef' });
  });

  it('uses the start of the id', () => expect(shortId('0123456789')).toBe('012345'));
});
