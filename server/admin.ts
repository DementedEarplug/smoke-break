// Hub admin tasks on the saved team file. Stop the hub first: a running hub
// rewrites the file from memory and would undo the change.
//
//   node server/admin.ts list                         teams (by ref) and their rosters
//   node server/admin.ts set-owner <team-ref> <id>    hand a team to someone on its roster
//
// Uses $SMOKE_BREAK_DATA_DIR/teams.json like the hub (or --file <path>).
// Never prints invite codes or meeting links.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataFileFromEnv, parseSavedTeam, writeAtomic } from './persistence.ts';

export function runAdmin(argv: string[], out: (line: string) => void = console.log): number {
  const args = [...argv];
  let file = dataFileFromEnv();
  const fi = args.indexOf('--file');
  if (fi >= 0) {
    file = args[fi + 1] ?? '';
    args.splice(fi, 2);
  }
  const [cmd, ref, id] = args;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    out(`Can't read ${file}: ${(err as Error).message}`);
    return 1;
  }
  if (!Array.isArray(data)) {
    out(`${file} is not a team list.`);
    return 1;
  }
  const now = Date.now();
  const teams = data.map((raw) => ({ raw: raw as Record<string, unknown>, team: parseSavedTeam(raw, now) }));

  if (cmd === 'list') {
    for (const { raw, team } of teams) {
      if (!team) continue;
      if (raw.ref !== team.ref) {
        out(`team "${team.name}" has no saved ref yet: start the hub once (it saves one), stop it, and list again.`);
        continue;
      }
      out(`team ${team.ref}  "${team.name}"  owner ${team.ownerId ?? '(none)'}  approval ${team.requireApproval ? 'on' : 'off'}  waiting ${team.pending.length}`);
      for (const m of team.roster) {
        out(`  ${m.id}  ${m.name || '(name not known yet)'}${m.label ? `  [${m.label}]` : ''}${m.id === team.ownerId ? '  (owner)' : ''}`);
      }
    }
    return 0;
  }

  if (cmd === 'set-owner' && ref && id) {
    const found = teams.find((t) => t.team?.ref === ref);
    if (!found?.team) {
      out(`No team with ref ${ref}. See: node server/admin.ts list`);
      return 1;
    }
    if (!found.team.roster.some((m) => m.id === id)) {
      out(`${id} is not on team ${ref}'s roster.`);
      return 1;
    }
    // Only this one field changes; everything else stays exactly as saved.
    found.raw.ownerId = id;
    writeAtomic(file, JSON.stringify(data, null, 2));
    out(`Team ${ref} is now owned by ${id}. Start the hub again.`);
    return 0;
  }

  out('Usage: node server/admin.ts [--file teams.json] list | set-owner <team-ref> <member-id>   (stop the hub first)');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(runAdmin(process.argv.slice(2)));
