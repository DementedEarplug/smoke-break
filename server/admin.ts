// Hub admin tasks on the saved team file. Run them as the hub's user (e.g.
// `sudo -u smoke-break node server/admin.ts …`), and stop the hub first for
// anything that changes the file: a running hub rewrites it from memory and
// would undo the change.
//
//   node server/admin.ts list                              teams (by ref), rosters and people waiting
//   node server/admin.ts codes <team-ref>                  a team's current invite code
//   node server/admin.ts set-owner <team-ref> <id>         hand a team to someone on its roster (or waiting);
//                                                          not held to the hub's teams-per-label cap (it says so)
//   node server/admin.ts unban <team-ref> <id|label>       lift a removal or denial
//   node server/admin.ts delete-team <team-ref> --yes      delete a team (its members' apps forget it)
//
// Uses $SMOKE_BREAK_DATA_DIR/teams.json like the hub (or --file <path>).
// Only `codes` prints an invite code; nothing prints meeting links.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ID, dataFileFromEnv, parseSavedTeam, writeAtomic } from './persistence.ts';

const USAGE =
  'Usage: node server/admin.ts [--file teams.json] list | codes <team-ref> | set-owner <team-ref> <member-id> [--unlabeled] | unban <team-ref> <member-id|label> | delete-team <team-ref> --yes\n' +
  'Run it as the hub\'s user (sudo -u <hub user> …), and stop the hub before set-owner, unban or delete-team.';

type Raw = Record<string, unknown>;

export interface AdminOptions {
  /** Who is running this (default: the process's user id). */
  uid?: number;
}

export function runAdmin(argv: string[], out: (line: string) => void = console.log, opts: AdminOptions = {}): number {
  const args = [...argv];
  let file = dataFileFromEnv();
  const fi = args.indexOf('--file');
  if (fi >= 0) {
    file = args[fi + 1] ?? '';
    args.splice(fi, 2);
  }
  const yi = args.indexOf('--yes');
  const yes = yi >= 0;
  if (yes) args.splice(yi, 1);
  const [cmd, ref, target] = args;
  if (!['list', 'codes', 'set-owner', 'unban', 'delete-team'].includes(cmd)) {
    out(USAGE);
    return 2;
  }

  // Writing the file as someone else (root, say) would leave the hub unable to read its own teams.
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    out(`Can't read ${file}: ${(err as Error).message}`);
    return 1;
  }
  const uid = opts.uid ?? process.getuid?.();
  if (uid !== undefined && uid !== st.uid) {
    out(`${file} belongs to user id ${st.uid}, and you are ${uid}. Run this as the hub's user, e.g.: sudo -u <hub user> node server/admin.ts ${args.join(' ')}`);
    return 1;
  }
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
  const teams = data.map((raw) => ({ raw: raw as Raw, team: parseSavedTeam(raw, now) }));
  /** Writes the file back with the same mode it had (and, since we're its owner, the same owner). */
  const write = () => writeAtomic(file, JSON.stringify(data, null, 2), st.mode & 0o777);

  if (cmd === 'list') {
    for (const { raw, team } of teams) {
      if (!team) continue;
      if (raw.ref !== team.ref) {
        out(`team "${team.name}" has no saved ref yet: start the hub once (it saves one), stop it, and list again.`);
        continue;
      }
      const ownerLabel = team.roster.find((m) => m.id === team.ownerId)?.label;
      const used = new Date(team.lastActive).toISOString().slice(0, 10);
      const madeBy = team.createdBy && team.createdBy !== ownerLabel ? `  made by [${team.createdBy}]` : '';
      out(
        `team ${team.ref}  "${team.name}"  owner ${team.ownerId ?? '(none)'}${ownerLabel ? ` [${ownerLabel}]` : ''}${madeBy}  approval ${team.requireApproval ? 'on' : 'off'}` +
          `  waiting ${team.pending.length}  last used ${used}${team.hadGroupBreak ? '' : '  (never had a group break)'}`,
      );
      for (const m of team.roster) {
        out(`  ${m.id}  ${m.name || '(name not known yet)'}${m.label ? `  [${m.label}]` : ''}${m.id === team.ownerId ? '  (owner)' : ''}`);
      }
      for (const p of team.pending) out(`  ${p.id}  ${p.name}${p.label ? `  [${p.label}]` : ''}  (waiting)`);
      for (const b of team.bannedLabels) out(`  label ${b.label} ${b.reason}${b.until ? ` until ${new Date(b.until).toISOString()}` : ''}`);
    }
    return 0;
  }

  const found = teams.find((t) => t.team?.ref === ref);
  if (!ref || !found?.team) {
    out(`No team with ref ${ref ?? '(none given)'}. See: node server/admin.ts list`);
    return 1;
  }
  const team = found.team;

  if (cmd === 'codes') {
    out(`team ${team.ref}  "${team.name}"  invite code: ${team.code}`);
    return 0;
  }

  if (cmd === 'delete-team') {
    const labels = [...new Set(team.roster.map((m) => m.label).filter(Boolean))];
    const what = `team ${team.ref} "${team.name}" (${team.roster.length} on the roster${labels.length ? `: ${labels.join(', ')}` : ''}, last used ${new Date(team.lastActive).toISOString()})`;
    if (!yes) {
      out(`This deletes ${what}. Its members' apps will forget it. To go ahead, stop the hub and run again with --yes.`);
      return 2;
    }
    data.splice(data.indexOf(found.raw), 1);
    write();
    out(`Deleted ${what}. Start the hub again.`);
    return 0;
  }

  if (!target) {
    out(USAGE);
    return 2;
  }

  if (cmd === 'set-owner') {
    const waiting = team.pending.find((p) => p.id === target);
    const member = team.roster.find((m) => m.id === target) ?? waiting;
    if (!member) {
      out(`${target} is not on team ${ref}'s roster or waiting to join it.`);
      return 1;
    }
    // On a hub with per-person tokens, an entry with no label isn't tied to anyone yet: as owner
    // it would go to whoever uses that device first, with any valid token, and nobody approves it.
    const usesLabels = teams.some((t) => t.team?.roster.some((m) => m.label) || t.team?.pending.some((p) => p.label));
    if (usesLabels && !member.label && !args.includes('--unlabeled')) {
      out(
        `${target} has no access-token label yet: they haven't connected since this hub started using per-person tokens. As owner, that device would be let in with the first valid token used on it, without anyone's approval. Have them connect once first (the owner approves them), or pick someone with a label (see list). To go ahead anyway, run again with --unlabeled.`,
      );
      return 1;
    }
    // Only these fields change; everything else stays exactly as saved.
    if (waiting) {
      // Someone who asked to join a team without an owner: they join it, as its owner.
      const { at: _at, ...entry } = waiting;
      found.raw.roster = [...team.roster, entry];
      found.raw.pending = team.pending.filter((p) => p.id !== target);
    }
    found.raw.ownerId = target;
    // Whoever made it keeps it on their count (files from before this was kept: the owner until now).
    found.raw.createdBy = team.createdBy;
    write();
    out(`Team ${ref} is now owned by ${target}. Start the hub again.`);
    // The hub's teams-per-label cap doesn't apply to an admin: say where that leaves the new owner.
    if (member.label) {
      const held = teams.filter(
        (t) => t.team && (t.team === team || t.team.createdBy === member.label || t.team.roster.find((m) => m.id === t.team!.ownerId)?.label === member.label),
      ).length;
      out(
        `Note: set-owner isn't held to the hub's limit of teams per label (SMOKE_BREAK_TEAMS_PER_LABEL, default 5). Label ${member.label} now holds ${held} team(s) (owned, or made by them); at or over the limit, they can't make or be handed another.`,
      );
    }
    return 0;
  }

  // unban: an id lifts that identity's ban; a label lifts the label's and every identity's under it.
  const byId = PUBLIC_ID.test(target) && team.banned.some((b) => b.id === target);
  const byLabel = team.bannedLabels.some((b) => b.label === target) || team.banned.some((b) => b.label === target);
  if (!byId && !byLabel) {
    out(`Nothing on team ${ref} is banned under ${target}.`);
    return 1;
  }
  const banned = team.banned.filter((b) => (byId ? b.id !== target : b.label !== target));
  const bannedLabels = team.bannedLabels.filter((b) => byId || b.label !== target);
  found.raw.banned = banned;
  // Written out even for an id, so a label ban that older files only implied stays in place.
  found.raw.bannedLabels = bannedLabels;
  write();
  out(`Lifted the ban on ${target} in team ${ref}. Start the hub again.`);
  const label = byId ? team.banned.find((b) => b.id === target)?.label : undefined;
  if (label && bannedLabels.some((b) => b.label === label)) {
    out(`Note: label ${label} is still banned from this team, so new devices under it still can't join. To lift that too: unban ${ref} ${label}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(runAdmin(process.argv.slice(2)));
