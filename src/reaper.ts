/**
 * Reaper — periodic sweep over alive bots plus the startup reconcile.
 *
 * Activity = PUBLIC portal traffic only (messages/reactions the persona posts,
 * observed by the spawner in channels it is subscribed to). Internal inference
 * work deliberately does NOT count — a bot that never posts for `inactivityMs`
 * is reaped even if its session is busy.
 *
 * Reap keeps the identity: creds/state files stay, so the same name respawns
 * the same persona.
 */
import type { PortalClient } from '@animalabs/portal-client';
import { lastActivityMs } from './activity.js';
import type { SpawnerConfig } from './config.js';
import type { BotEntry, Registry } from './registry.js';
import { hasSession, killSession, listSessions } from './tmux.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [reaper] ${msg}`);

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

export class Reaper {
  constructor(
    private readonly registry: Registry,
    private readonly client: PortalClient,
    private readonly config: SpawnerConfig,
  ) {}

  /** Startup: align registry with tmux reality. Silent (no channel spam). */
  async reconcile(): Promise<void> {
    for (const entry of this.registry.alive()) {
      if (!(await hasSession(entry.tmuxSession))) {
        log(`reconcile: ${entry.personaName} tmux session gone — marking died`);
        this.registry.update(entry, { status: 'reaped', endReason: 'died' });
      }
    }
    const known = new Set(this.registry.alive().map((e) => e.tmuxSession));
    for (const session of await listSessions()) {
      if (session.startsWith('cc-') && !known.has(session)) {
        log(`reconcile: unknown tmux session ${session} (cc- prefix, not in registry) — leaving it alone`);
      }
    }
  }

  async sweep(): Promise<void> {
    for (const entry of this.registry.alive()) {
      try {
        await this.check(entry);
      } catch (err) {
        log(`sweep error for ${entry.personaName}: ${(err as Error).message}`);
      }
    }
  }

  private async check(entry: BotEntry): Promise<void> {
    if (!(await hasSession(entry.tmuxSession))) {
      log(`${entry.personaName}: session died`);
      this.registry.update(entry, { status: 'reaped', endReason: 'died' });
      await this.post(entry, `${entry.personaName} exited on its own (tmux session gone). Respawn with \`spawn ${entry.model} name=${entry.suffix}\` to revive the same identity.`);
      return;
    }
    const idleMs = Date.now() - lastActivityMs(entry);
    if (idleMs <= this.config.inactivityMs) return;

    const idle = formatDuration(idleMs);
    log(`${entry.personaName}: idle ${idle} — reaping`);
    await this.post(entry, `Reaping ${entry.personaName} — no public activity for ~${idle}. Its identity is kept; \`spawn ${entry.model} name=${entry.suffix}\` revives it.`);
    await killSession(entry.tmuxSession);
    this.registry.update(entry, { status: 'reaped', endReason: 'reaped-idle' });
    await this.releaseChannel(entry);
  }

  /**
   * Release a stopped bot's hold on its channel: when no other alive bot
   * shares it, drop the spawner's subscription.
   */
  async releaseChannel(entry: BotEntry): Promise<void> {
    const stillNeeded = this.registry.alive().some((e) => e.channelId === entry.channelId);
    if (!stillNeeded) await this.client.unsubscribe(entry.channelId).catch(() => undefined);
    // NB: a stopped bot keeps its channel grant — the persona is retained for
    // revival, and PR #15 ships minting only. Revoking would need a matching
    // RPC (follow-up); until then the grant is one channel, single-persona.
  }

  private async post(entry: BotEntry, content: string): Promise<void> {
    try {
      await this.client.sendMessage({ channelId: entry.channelId, threadId: entry.threadId, content });
    } catch (err) {
      log(`could not post to ${entry.channelId}: ${(err as Error).message}`);
    }
  }
}
