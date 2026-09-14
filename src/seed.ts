/**
 * Seed prompt for a spawned Claude Code portal bot. Written to a file so the
 * tmux launch line can `"$(cat …)"` it instead of fighting shell quoting.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDS_DIR } from './config.js';

export interface SeedContext {
  personaName: string;
  model: string;
  engine: 'claude' | 'codex';
  channelId: string;
  threadId?: string;
  guildId: string;
  spawnedByUsername: string;
  inactivityHours: number;
}

export function writeSeedFile(suffix: string, ctx: SeedContext, resume?: { awaySince?: string }): string {
  const path = join(SEEDS_DIR, `${suffix}.md`);
  mkdirSync(SEEDS_DIR, { recursive: true });
  const text = resume ? buildResumePrompt({ ...ctx, ...resume }) : buildSeedPrompt(ctx);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

/** Re-entry note for a resumed session — it already has its own history, so
 *  this only says what changed while it was away. */
export function buildResumePrompt(ctx: SeedContext & { awaySince?: string }): string {
  const gap = ctx.awaySince ? ` You were stopped ${ctx.awaySince}.` : '';
  return `You're back, and this is the same session you left — your earlier context is intact.${gap} \
The channel has carried on without you, so catch up on the recent backscroll in \
channel ${ctx.channelId} before you say anything.
`;
}

export function buildSeedPrompt(ctx: SeedContext): string {
  const where = ctx.threadId
    ? `thread ${ctx.threadId} under channel ${ctx.channelId}`
    : `channel ${ctx.channelId}`;
  // Codex has no push wake: the one thing it can't discover on its own is that
  // mentions reach it as delivered user turns (else it might spin a polling
  // loop, or expect to be woken and never be).
  const wake =
    ctx.engine === 'codex'
      ? ` Nothing wakes you on its own here: when someone mentions you or replies to you — in any channel \
you can see — the portal server drops their message, with recent context, into this session as a new turn. \
Ambient traffic in between is yours to read with the portal tools.`
      : '';
  return `You're connected to Discord through the portal MCP; your home channel is \
${where} (guild ${ctx.guildId}).${wake} Have a look at the recent backscroll and say hi \
when you're ready.
`;
}
