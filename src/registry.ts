/**
 * Persistent registry of spawned bots — ~/.portal/cc-spawner.registry.json.
 * Atomic writes (tmp + rename). Reaped entries are kept as history; reviving a
 * name creates a fresh entry (creds reuse makes it the same portal identity).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { REGISTRY_PATH } from './config.js';

export type BotStatus = 'alive' | 'reaped';

export interface BotEntry {
  /** Visible name suffix — 4 random hex or the operator-chosen friendly name. */
  suffix: string;
  /** Discord-visible persona name, e.g. Claude-Code-3f2a. */
  personaName: string;
  /** Relay persona id (known at spawn time via pre-enroll). */
  personaId: string;
  /** Creds cache path (~/.portal/<slug>.creds.json) — KEPT on reap. */
  credsPath: string;
  tmuxSession: string;
  /** Channel the bot was spawned in (its home channel). */
  channelId: string;
  threadId?: string;
  guildId: string;
  engine: 'claude' | 'codex';
  /** Claude Code conversation id (we assign it via --session-id) so a revival
   *  can --resume the SAME transcript instead of starting amnesiac. */
  sessionId?: string;
  /** Who wakes a codex hand on a mention/reply. 'cc-cli': the hand's own portal
   *  server queues the turn (guild-wide, mentions AND replies) from the wake
   *  sidecar the launcher writes. undefined/'spawner': legacy home-channel-only
   *  wake in main.ts, kept for hands launched before the sidecar existed. */
  wake?: 'spawner' | 'cc-cli';
  model: string;
  spawnedBy: { userId: string; username: string };
  spawnedAt: string;
  /** Last PUBLIC portal activity (message/reaction) observed by the spawner. */
  lastActivity: string;
  status: BotStatus;
  /** Why the entry left 'alive' (reaped-idle | died | killed). */
  endReason?: string;
  seedFile: string;
  /** Transcript-watch byte offset — how far into the session JSONL the watcher
   *  has read (persisted so daemon restarts don't replay old events). */
  transcriptOffset?: number;
  /** Last assistant model observed in the transcript (fallback detection). */
  lastModel?: string;
  /** An AskUserQuestion dialog the session is currently blocked on (posted to
   *  the channel; cleared when its tool_result lands in the transcript). */
  pendingQuestion?: import('./question.js').PendingQuestion;
}

export class Registry {
  private entries: BotEntry[] = [];

  load(): void {
    if (existsSync(REGISTRY_PATH)) {
      this.entries = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as BotEntry[];
    }
  }

  save(): void {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    const tmp = `${REGISTRY_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, REGISTRY_PATH);
  }

  all(): readonly BotEntry[] {
    return this.entries;
  }

  alive(): BotEntry[] {
    return this.entries.filter((e) => e.status === 'alive');
  }

  /** Find an ALIVE entry by friendly suffix, persona name, or persona id. */
  findAlive(target: string): BotEntry | undefined {
    const t = target.toLowerCase();
    return this.alive().find(
      (e) =>
        e.suffix.toLowerCase() === t ||
        e.personaName.toLowerCase() === t ||
        e.personaId.toLowerCase() === t ||
        e.tmuxSession.toLowerCase() === t,
    );
  }

  byPersonaId(personaId: string): BotEntry | undefined {
    return this.alive().find((e) => e.personaId === personaId);
  }

  add(entry: BotEntry): void {
    this.entries.push(entry);
    this.save();
  }

  /** Mutate an entry in place, then persist. */
  update(entry: BotEntry, patch: Partial<BotEntry>): void {
    Object.assign(entry, patch);
    this.save();
  }
}
