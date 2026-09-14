/**
 * Public activity of a hand = the later of (a) what the spawner saw itself —
 * persona-authored messages/reactions in the channels it subscribes to — and
 * (b) the beacon the hand's own portal server (portal-mcpl cc-cli) touches on
 * every post/reaction/edit, wherever it happens. The spawner only subscribes
 * to spawn channels, so a hand working in some other channel looked idle to
 * the reaper before the beacon existed (Bones, 2026-09-09).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { PORTAL_DIR } from './config.js';
import type { BotEntry } from './registry.js';

export function activityBeaconPath(personaId: string): string {
  return join(PORTAL_DIR, `${personaId}.activity`);
}

/** Epoch ms of the hand's last public activity. */
export function lastActivityMs(entry: BotEntry): number {
  let t = Date.parse(entry.lastActivity) || 0;
  try {
    const beacon = statSync(activityBeaconPath(entry.personaId)).mtimeMs;
    if (beacon > t) t = beacon;
  } catch {
    /* no beacon yet — hand predates it, or hasn't posted */
  }
  return t;
}
