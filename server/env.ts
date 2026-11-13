// On/off settings from the environment, read the same way everywhere in the hub.

/** Words that turn a setting on, and words (or nothing) that leave it off; case doesn't matter. */
export const ON_WORDS = /^(1|true|yes|on)$/i;
export const OFF_WORDS = /^(|0|false|no|off)$/i;

/**
 * An on/off setting: `1`, `true`, `yes`, `on` are on; unset, empty, `0`,
 * `false`, `no`, `off` are off (trimmed, any case). Anything else throws, so a
 * typo can't silently leave a protection off (the hub then refuses to start).
 */
export function envBool(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[name] ?? '').trim();
  if (ON_WORDS.test(v)) return true;
  if (OFF_WORDS.test(v)) return false;
  throw new Error(`${name}=${JSON.stringify(v.slice(0, 40))} is not an on/off value: use 1, true, yes or on to turn it on, or 0, false, no, off (or leave it unset) to turn it off.`);
}
