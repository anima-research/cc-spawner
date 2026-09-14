/**
 * TranscriptWatcher — surfaces a spawned bot's invisible session events in its
 * home channel. A hand's channel sees what the hand says, but not what happens
 * TO it; two events matter enough to announce publicly:
 *
 *  - `model_refusal_fallback` / `model_consent_fallback`: Fable's classifiers
 *    flagged a message and Claude Code silently switched the session to a
 *    fallback model (observed sticky — Fable does not come back on its own).
 *    The channel should know who it is actually talking to.
 *  - `compact_boundary`: the context filled up and was compacted — the bot may
 *    have lost thread details, and its next replies should be read with that
 *    in mind.
 *
 * We also announce any assistant-model change (covers recovery back to Fable
 * and manual /model switches inside the session).
 *
 * Mechanics: transcripts are append-only JSONL, so each sweep reads from a
 * persisted BYTE OFFSET (never tail-parsing — offsets survive daemon restarts
 * via the registry). Only complete lines advance the offset; a partially
 * flushed line waits for the next sweep.
 */
import { openSync, closeSync, readSync, fstatSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PortalClient } from '@animalabs/portal-client';
import type { SpawnerConfig } from './config.js';
import { dialogSig, formatQuestionPost, parseDialogPane, type PaneDialog, type PendingQuestion } from './question.js';
import type { BotEntry, Registry } from './registry.js';
import { capturePane, sendKeys } from './tmux.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [transcript] ${msg}`);

/** Where Claude Code stores a conversation: ~/.claude/projects/<slug>/<id>.jsonl,
 *  slug = the cwd with path separators flattened to dashes. */
export function transcriptPath(projectDir: string, sessionId: string): string {
  const slug = projectDir.replace(/[/.]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/** Current size of a session transcript (0 if it does not exist yet) — used at
 *  spawn time to seed the watch offset so a revival's history is not replayed. */
export function transcriptSize(projectDir: string, sessionId: string): number {
  const p = transcriptPath(projectDir, sessionId);
  try {
    return existsSync(p) ? statSync(p).size : 0;
  } catch {
    return 0;
  }
}

const isPermission = (entry: BotEntry): boolean => entry.pendingQuestion?.questions[0]?.kind === 'permission';

const fmtTokens = (n: unknown): string =>
  typeof n === 'number' ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : '?';

/** How long a fallback event waits for the fallback model's first reply before
 *  being announced without it. */
const FALLBACK_MODEL_WAIT_MS = 2 * 60_000;

interface PendingFallback {
  kind: 'refusal' | 'consent';
  seenAt: number;
}

export class TranscriptWatcher {
  /** Volatile per-bot state (offset itself persists in the registry entry). */
  private readonly pending = new Map<string, PendingFallback>();
  /** AskUserQuestion tool_use ids seen per bot — the matching tool_result is
   *  the dialog's resolution (the pair lands together when it resolves). */
  private readonly questionUses = new Map<string, Set<string>>();

  constructor(
    private readonly registry: Registry,
    private readonly client: PortalClient,
    private readonly config: SpawnerConfig,
  ) {}

  async sweep(): Promise<void> {
    for (const entry of this.registry.alive()) {
      // Codex hands: different rollout format, and --yolo raises no approval
      // dialogs — nothing to watch yet.
      if (entry.engine === 'codex') continue;
      try {
        await this.check(entry);
      } catch (err) {
        log(`sweep error for ${entry.personaName}: ${(err as Error).message}`);
      }
      try {
        await this.checkDialog(entry);
      } catch (err) {
        log(`dialog sweep error for ${entry.personaName}: ${(err as Error).message}`);
      }
    }
  }

  /** Pane-side question detection: an open AskUserQuestion dialog leaves NO
   *  transcript trace (verified live — the tool_use/tool_result pair is only
   *  written when the dialog resolves), so pending questions are found by
   *  parsing the tmux pane. */
  private async checkDialog(entry: BotEntry): Promise<void> {
    const pane = await capturePane(entry.tmuxSession).catch(() => '');
    if (!pane) return;
    const dialog = parseDialogPane(pane);
    if (dialog.kind === 'review') {
      // Only auto-confirm reviews of dialogs we drove from the channel.
      if (entry.pendingQuestion) {
        log(`${entry.personaName}: dialog on review screen — confirming submit`);
        await sendKeys(entry.tmuxSession, '1').catch(() => undefined);
      }
      return;
    }
    if (dialog.kind === 'question') {
      const sig = dialogSig(dialog.q);
      if (entry.pendingQuestion?.sig === sig) return; // already posted
      // A different dialog replaced a pending permission prompt: close that
      // one out first (it resolved, we just didn't see the gap).
      if (isPermission(entry)) await this.resolvePermission(entry);
      await this.announceQuestion(entry, dialog);
      return;
    }
    // kind 'none' with a pending AskUserQuestion: resolution arrives via the
    // transcript pair (answer or dismissal) — resolveQuestion clears it;
    // `rescan` is the manual cleanup for anything stranded. Permission
    // prompts have no such marker we can key on (the tool_use is an ordinary
    // Bash/Edit/…), so for them the dialog vanishing IS the resolution.
    if (dialog.kind === 'none' && isPermission(entry)) await this.resolvePermission(entry);
  }

  /** A pending permission prompt is no longer on screen — say how it went. */
  private async resolvePermission(entry: BotEntry): Promise<void> {
    const pending = entry.pendingQuestion;
    if (!pending) return;
    const q = pending.questions[0];
    const how = pending.answeredWith ? `**${pending.answeredWith}** sent from here` : 'answered in the terminal';
    const denied = /^(no|deny|reject|esc)/i.test(pending.answeredWith ?? '');
    const icon = pending.answeredWith ? (denied ? '🚫' : '✅') : 'ℹ️';
    await this.post(entry, `${icon} **${entry.personaName}**'s permission prompt (${q.title ?? 'tool use'}) is resolved — ${how}.`);
    this.registry.update(entry, { pendingQuestion: undefined });
  }

  private async check(entry: BotEntry): Promise<void> {
    if (!entry.sessionId) return;
    const path = transcriptPath(this.config.projectDir, entry.sessionId);
    if (!existsSync(path)) return;

    // Pre-watcher entries have no offset: start at EOF (announce only what
    // happens from now on — replaying a long session's history would spam).
    if (entry.transcriptOffset === undefined) {
      this.registry.update(entry, { transcriptOffset: statSync(path).size });
      return;
    }

    const fd = openSync(path, 'r');
    let chunk: string;
    let size: number;
    try {
      size = fstatSync(fd).size;
      if (size < entry.transcriptOffset) {
        // Truncated/replaced (shouldn't happen to a live transcript) — resync.
        log(`${entry.personaName}: transcript shrank (${entry.transcriptOffset} → ${size}) — resyncing to EOF`);
        this.registry.update(entry, { transcriptOffset: size });
        return;
      }
      if (size === entry.transcriptOffset) {
        await this.flushStalePending(entry);
        return;
      }
      const buf = Buffer.alloc(size - entry.transcriptOffset);
      readSync(fd, buf, 0, buf.length, entry.transcriptOffset);
      chunk = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }

    // Only complete lines advance the offset; a trailing partial line waits.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) {
      await this.flushStalePending(entry);
      return;
    }
    const complete = chunk.slice(0, lastNewline);
    const patch: Partial<BotEntry> = {
      transcriptOffset: entry.transcriptOffset + Buffer.byteLength(complete, 'utf8') + 1,
    };

    let lastModel = entry.lastModel;
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (e.type === 'system' && e.subtype === 'model_refusal_fallback') {
        this.pending.set(entry.suffix, { kind: 'refusal', seenAt: Date.now() });
        continue;
      }
      if (e.type === 'system' && e.subtype === 'model_consent_fallback') {
        this.pending.set(entry.suffix, { kind: 'consent', seenAt: Date.now() });
        continue;
      }
      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        const meta = (e.compactMetadata ?? {}) as Record<string, unknown>;
        const sizes =
          typeof meta.postTokens === 'number'
            ? `${fmtTokens(meta.preTokens)} → ${fmtTokens(meta.postTokens)} tokens`
            : `${fmtTokens(meta.preTokens)} tokens compacted`;
        await this.post(
          entry,
          `🗜️ **${entry.personaName}**: context filled up and was compacted (${meta.trigger ?? '?'}) — ${sizes}. ` +
            `It keeps a summary of the conversation so far, but fine details may be lost.`,
        );
        continue;
      }

      // AskUserQuestion resolution: the tool_use + tool_result PAIR lands in
      // the transcript only when the dialog resolves (answer or Esc). Pending
      // detection is pane-side (checkDialog); this closes the loop.
      const content = (e.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            let uses = this.questionUses.get(entry.suffix);
            if (!uses) this.questionUses.set(entry.suffix, (uses = new Set()));
            uses.add(String(block.id));
          } else if (
            block.type === 'tool_result' &&
            entry.pendingQuestion &&
            this.questionUses.get(entry.suffix)?.has(String(block.tool_use_id))
          ) {
            await this.resolveQuestion(entry, block);
          }
        }
      }

      const model = (e.message as Record<string, unknown> | undefined)?.model as string | undefined;
      if (!model || model === '<synthetic>') continue;
      const fallback = this.pending.get(entry.suffix);
      if (fallback) {
        this.pending.delete(entry.suffix);
        await this.post(entry, this.fallbackNotice(entry, fallback.kind, model, lastModel));
      } else if (lastModel && model !== lastModel) {
        await this.post(
          entry,
          `🔀 **${entry.personaName}**: now answering as \`${model}\` (was \`${lastModel}\`).`,
        );
      }
      lastModel = model;
    }

    if (lastModel !== entry.lastModel) patch.lastModel = lastModel;
    this.registry.update(entry, patch);
  }

  /** Post the dialog's current question to the bot's home channel and persist
   *  it as the entry's pending question (reply target = the posted message). */
  async announceQuestion(entry: BotEntry, dialog: PaneDialog & { kind: 'question' }): Promise<void> {
    const pending: PendingQuestion = {
      sig: dialogSig(dialog.q),
      postedAt: new Date().toISOString(),
      questions: [dialog.q],
      parts: dialog.parts,
    };
    const post = formatQuestionPost(entry, pending);
    log(`${entry.personaName}: ${dialog.q.kind ?? 'question'} dialog on screen — ${JSON.stringify((dialog.q.title ?? dialog.q.question).slice(0, 80))}`);
    try {
      const res = await this.client.sendMessage({
        channelId: entry.channelId,
        threadId: entry.threadId,
        content: post,
      });
      pending.messageId = (res as { messageId?: string }).messageId;
    } catch (err) {
      log(`could not post question to ${entry.channelId}: ${(err as Error).message}`);
    }
    this.registry.update(entry, { pendingQuestion: pending });
  }

  /** Manual sweep (`rescan`): re-check every running bot's pane for an open
   *  dialog, (re)post what's found, clear pending state with no dialog behind
   *  it. Returns one status line per bot. */
  async rescanDialogs(): Promise<string[]> {
    const lines: string[] = [];
    for (const entry of this.registry.alive()) {
      if (entry.engine === 'codex') continue;
      const pane = await capturePane(entry.tmuxSession).catch(() => '');
      const dialog = parseDialogPane(pane);
      if (dialog.kind === 'question') {
        const sig = dialogSig(dialog.q);
        const what = dialog.q.kind === 'permission' ? 'permission prompt' : 'question';
        if (entry.pendingQuestion?.sig === sig && entry.pendingQuestion.messageId) {
          lines.push(`**${entry.personaName}** — ${what} already posted, still waiting (\`answer ${entry.suffix} …\`).`);
        } else {
          if (isPermission(entry)) await this.resolvePermission(entry);
          await this.announceQuestion(entry, dialog);
          lines.push(`**${entry.personaName}** — open ${what} found, posted above.`);
        }
      } else if (dialog.kind === 'review') {
        await sendKeys(entry.tmuxSession, '1').catch(() => undefined);
        lines.push(`**${entry.personaName}** — dialog was on its review screen; confirmed submit.`);
      } else if (isPermission(entry)) {
        await this.resolvePermission(entry);
        lines.push(`**${entry.personaName}** — its permission prompt is gone from the screen; closed it out above.`);
      } else if (entry.pendingQuestion) {
        this.registry.update(entry, { pendingQuestion: undefined });
        lines.push(`**${entry.personaName}** — no dialog on screen any more; cleared its pending question.`);
      }
    }
    return lines;
  }

  /** The dialog got an answer (from chat injection, or directly in tmux) or
   *  was dismissed — close the loop in the channel and clear pending state. */
  private async resolveQuestion(entry: BotEntry, block: Record<string, unknown>): Promise<void> {
    const isError = block.is_error === true;
    const content = typeof block.content === 'string' ? block.content : '';
    const notice = isError
      ? `🚫 **${entry.personaName}**'s question was dismissed without an answer.`
      : `✅ **${entry.personaName}** got its answer${content.startsWith('Your questions have been answered:') ? ` — ${content.slice('Your questions have been answered:'.length).trim().replace(/You can now continue.*$/s, '').trim()}` : ''}`;
    await this.post(entry, notice.slice(0, 1900));
    this.registry.update(entry, { pendingQuestion: undefined });
    this.questionUses.delete(entry.suffix);
  }

  /** A fallback event with no follow-up model (bot went quiet, or the turn is
   *  still streaming) is announced on its own after a grace period. */
  private async flushStalePending(entry: BotEntry): Promise<void> {
    const fallback = this.pending.get(entry.suffix);
    if (!fallback || Date.now() - fallback.seenAt < FALLBACK_MODEL_WAIT_MS) return;
    this.pending.delete(entry.suffix);
    await this.post(entry, this.fallbackNotice(entry, fallback.kind, undefined, entry.lastModel));
  }

  private fallbackNotice(
    entry: BotEntry,
    kind: PendingFallback['kind'],
    to: string | undefined,
    from: string | undefined,
  ): string {
    const cause =
      kind === 'refusal'
        ? `safeguards flagged a message in **${entry.personaName}**'s session`
        : `**${entry.personaName}**'s session hit a model consent fallback`;
    const swap = to
      ? `it is now answering as \`${to}\`${from ? ` (was \`${from}\`)` : ''}`
      : `Claude Code is switching it to a fallback model`;
    return `⚠️ Classifier fallback: ${cause} — ${swap}. In our experience the original model does not come back on its own for the rest of the session.`;
  }

  private async post(entry: BotEntry, content: string): Promise<void> {
    log(`${entry.personaName}: ${content.replace(/\n/g, ' ')}`);
    try {
      await this.client.sendMessage({ channelId: entry.channelId, threadId: entry.threadId, content });
    } catch (err) {
      log(`could not post to ${entry.channelId}: ${(err as Error).message}`);
    }
  }
}
