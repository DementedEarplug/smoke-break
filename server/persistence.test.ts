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
});
