// Item 8 (safe saves, data directory checks) and the admin CLI (item 2: owner recovery).

import { chmodSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAdmin } from './admin.ts';
import { createHub, publicId } from './hub.ts';
import { saved, tempDir } from './hubHarness.ts';
import { checkDataDir, writeAtomic } from './persistence.ts';

describe('saving (item 8)', () => {
  it('writes through a fresh, randomly named temp file, 0600, and leaves nothing behind', () => {
    const dir = tempDir();
    const file = join(dir, 'teams.json');
    // What the old, predictable temp name could have been made to point at.
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'untouched');
    symlinkSync(victim, `${file}.${process.pid}.tmp`);
    writeAtomic(file, '[1]');
    writeAtomic(file, '[2]');
    expect(readFileSync(file, 'utf8')).toBe('[2]');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(readdirSync(dir).sort()).toEqual(['teams.json', `teams.json.${process.pid}.tmp`, 'victim'].sort());
  });

  it('refuses a data directory other users can write to, and says why', () => {
    const dir = tempDir();
    chmodSync(dir, 0o777);
    expect(() => checkDataDir(dir)).toThrow(/can be written by other users.*chmod 700/);
    expect(() => createHub({ dataFile: join(dir, 'teams.json'), log: () => {} })).toThrow(/other users/);
    chmodSync(dir, 0o755);
    expect(() => checkDataDir(dir)).not.toThrow();
  });

  it('creates a missing data directory private to this user', () => {
    const dir = join(tempDir(), 'a', 'b');
    checkDataDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('admin CLI (item 2: ownership recovery)', () => {
  function setup() {
    const dir = tempDir();
    const file = join(dir, 'teams.json');
    const owner = publicId('ADMINTEAM2', 'gone-owner-client-id-0000');
    const member = publicId('ADMINTEAM2', 'member-client-id-0000000');
    writeFileSync(
      file,
      JSON.stringify([
        saved({ code: 'ADMINTEAM2', ref: '0a0b0c0d', zoomLink: 'https://zoom.us/j/5551234', ownerId: owner, roster: [{ id: owner, name: 'Gone' }, { id: member, name: 'Pat' }] }),
      ]),
    );
    chmodSync(file, 0o600);
    return { file, owner, member };
  }

  it('lists teams without codes or links', () => {
    const { file, member } = setup();
    const out: string[] = [];
    expect(runAdmin(['--file', file, 'list'], (l) => out.push(l))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('team 0a0b0c0d');
    expect(text).toContain(`${member}  Pat`);
    expect(text).not.toContain('ADMINTEAM2');
    expect(text).not.toContain('5551234');
  });

  it('hands a team to someone on its roster, changing nothing else', () => {
    const { file, member } = setup();
    const before = JSON.parse(readFileSync(file, 'utf8'));
    expect(runAdmin(['--file', file, 'set-owner', '0a0b0c0d', 'notonrosternoton'], () => {})).toBe(1);
    expect(runAdmin(['--file', file, 'set-owner', 'ffffffff', member], () => {})).toBe(1);
    expect(runAdmin(['--file', file, 'set-owner', '0a0b0c0d', member], () => {})).toBe(0);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after).toEqual([{ ...before[0], ownerId: member }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(runAdmin(['--file', file, 'oops'], () => {})).toBe(2);
    expect(existsSync(file)).toBe(true);
  });

  it("won't run as a different user than the file's owner, and keeps the file's mode (item 3)", () => {
    const { file, member } = setup();
    const before = readFileSync(file, 'utf8');
    const out: string[] = [];
    const other = (process.getuid?.() ?? 0) + 1;
    expect(runAdmin(['--file', file, 'set-owner', '0a0b0c0d', member], (l) => out.push(l), { uid: other })).toBe(1);
    expect(out.join('\n')).toMatch(/belongs to user id .*sudo -u <hub user>/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    chmodSync(file, 0o640);
    expect(runAdmin(['--file', file, 'set-owner', '0a0b0c0d', member], () => {})).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(statSync(file).uid).toBe(process.getuid?.());
  });

  it('prints a team’s current invite code on request, and only then (item 3)', () => {
    const { file } = setup();
    const out: string[] = [];
    expect(runAdmin(['--file', file, 'codes', '0a0b0c0d'], (l) => out.push(l))).toBe(0);
    expect(out.join('\n')).toContain('invite code: ADMINTEAM2');
    expect(out.join('\n')).not.toContain('5551234');
    expect(runAdmin(['--file', file, 'codes', 'ffffffff'], () => {})).toBe(1);
  });

  it('lifts removals and denials by id or by label (item 1)', () => {
    const dir = tempDir();
    const file = join(dir, 'teams.json');
    const owner = publicId('UNBANTEAM2', 'owner-client-id-00000000');
    const mal1 = publicId('UNBANTEAM2', 'mallory-client-id-00001');
    const mal2 = publicId('UNBANTEAM2', 'mallory-client-id-00002');
    const kim = publicId('UNBANTEAM2', 'kim-secret-client-id-0003');
    writeFileSync(
      file,
      JSON.stringify([
        saved({
          code: 'UNBANTEAM2',
          ref: '0a0a0a0a',
          ownerId: owner,
          roster: [{ id: owner, name: 'O' }],
          // An older file: the label ban is only implied by the bans carrying it.
          banned: [
            { id: mal1, reason: 'removed', label: 'mallory' },
            { id: mal2, reason: 'removed', label: 'mallory' },
            { id: kim, reason: 'denied' },
          ],
        }),
      ]),
    );
    chmodSync(file, 0o600);
    const out: string[] = [];
    expect(runAdmin(['--file', file, 'unban', '0a0a0a0a', mal1], (l) => out.push(l))).toBe(0);
    expect(out.join('\n')).toMatch(/label mallory is still banned/);
    let t = JSON.parse(readFileSync(file, 'utf8'))[0];
    expect(t.banned.map((b: { id: string }) => b.id)).toEqual([mal2, kim]);
    expect(t.bannedLabels).toEqual([{ label: 'mallory', reason: 'removed' }]);
    expect(runAdmin(['--file', file, 'unban', '0a0a0a0a', 'mallory'], () => {})).toBe(0);
    t = JSON.parse(readFileSync(file, 'utf8'))[0];
    expect(t.banned.map((b: { id: string }) => b.id)).toEqual([kim]);
    expect(t.bannedLabels).toEqual([]);
    expect(runAdmin(['--file', file, 'unban', '0a0a0a0a', kim], () => {})).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].banned).toEqual([]);
    expect(runAdmin(['--file', file, 'unban', '0a0a0a0a', 'nobody'], () => {})).toBe(1);
  });
});
