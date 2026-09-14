/**
 * SpawnerActions — the transport-agnostic core. Both control surfaces (portal
 * @-mentions and Discord slash commands) build an Invocation and call run();
 * the returned string is the reply, rendered however the transport likes.
 *
 * All mutating work (spawn/stop, plus reaper sweeps via enqueue) is serialized
 * through one queue: tmux, the registry, and ~/.claude.json are shared state.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PortalClient } from '@animalabs/portal-client';
import { isAllowed, type Invoker } from './auth.js';
import { PEEK_DEFAULT_LINES, USAGE, isBareFamilyAlias, modelSlug, type Command } from './commands.js';
import { sendKeys, sendText } from './tmux.js';
import { PORTAL_DIR, type SpawnerConfig } from './config.js';
import { slugPersonaName, type Launcher } from './launcher.js';
import type { ChannelInviteMinter } from './grants.js';
import type { Reaper } from './reaper.js';
import type { BotEntry, Registry } from './registry.js';
import { injectAnswer, parseAnswerSpec } from './question.js';
import { writeSeedFile } from './seed.js';
import { transcriptPath, transcriptSize, type TranscriptWatcher } from './transcript-watch.js';
import { lastActivityMs } from './activity.js';
import { capturePane, hasSession, killSession, listSessions, sessionUptime } from './tmux.js';

/** `press` key words → tmux key names. Anything else is sent as literal text. */
const KEY_NAMES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', 'shift-tab': 'BTab',
  space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', backspace: 'BSpace',
  'ctrl-c': 'C-c', '^c': 'C-c', 'ctrl-u': 'C-u', '^u': 'C-u', 'ctrl-d': 'C-d', '^d': 'C-d',
};

const log = (msg: string) => console.log(`${new Date().toISOString()} [actions] ${msg}`);

/** Inline code block must stay under Discord's 2000-char message limit,
 *  leaving room for the header and fences. */
const PEEK_INLINE_BUDGET = 1700;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.round((seconds % 3600) / 60)}m`;
}

export interface Invocation {
  cmd: Command;
  guildId: string | null;
  channelId: string;
  threadId?: string;
  invoker: Invoker;
  /** Which surface this came from — audit strings only. */
  via: 'portal' | 'slash';
}

/** A reply from the core. Transports render it: portal posts `content`
 *  in-channel; the slash surface DMs when `private` and attaches `files`. */
export interface ActionResult {
  content: string;
  files?: { name: string; text: string }[];
  /** Deliver to the invoker privately (DM) rather than in the channel. */
  private?: boolean;
}

export class SpawnerActions {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: SpawnerConfig,
    private readonly registry: Registry,
    private readonly launchers: Map<string, Launcher>,
    private readonly client: PortalClient,
    private readonly reaper: Reaper,
    private readonly grants: ChannelInviteMinter,
    private readonly watcher: TranscriptWatcher,
  ) {}

  /** Serialize a task onto the shared mutation queue (also used by sweeps). */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const p = this.queue.then(task);
    this.queue = p.catch((err) => log(`queued task error: ${(err as Error).stack ?? err}`));
    return p;
  }

  /** Authorize + dispatch. Always resolves to a renderable reply. */
  run(inv: Invocation): Promise<ActionResult> {
    return this.enqueue(() => this.execute(inv));
  }

  /** Is this invoker allowed? Exposed for autocomplete gating (must be gated
   *  identically to execution). */
  authorized(inv: Pick<Invocation, 'invoker' | 'guildId'>): boolean {
    return isAllowed(inv.invoker, inv.guildId, this.config).ok;
  }

  private async execute(inv: Invocation): Promise<ActionResult> {
    // Hands can't spawn hands: a persona we ourselves spawned (any status, ever)
    // or anything in the Claude-Code namespace is refused regardless of
    // allowlists — keeps the delegation tree one level deep.
    if (
      inv.invoker.kind === 'resident' &&
      (/^(claude-code|codex)-/i.test(inv.invoker.id) || this.registry.all().some((e) => e.personaId === inv.invoker.id))
    ) {
      log(`denied spawned-hand persona ${inv.invoker.id}`);
      return { content: 'Spawned instances cannot drive the spawner.' };
    }
    const auth = isAllowed(inv.invoker, inv.guildId, this.config);
    if (!auth.ok) {
      log(`denied @${inv.invoker.name} (${inv.invoker.id}) via ${inv.via}: ${auth.reason}`);
      return { content: `Not authorized: ${auth.reason}` };
    }
    const cmd = inv.cmd;
    log(`command from @${inv.invoker.name} via ${inv.via}: ${JSON.stringify(cmd)}`);
    switch (cmd.kind) {
      case 'spawn':
        return { content: await this.spawn(inv, cmd) };
      case 'list':
        return { content: this.list() };
      case 'stop':
        return { content: await this.stop(inv, cmd.target) };
      case 'peek':
        return this.peek(inv, cmd.target, cmd.lines);
      case 'answer':
        return { content: await this.answer(cmd.target, cmd.spec) };
      case 'press':
        return { content: await this.press(cmd.target, cmd.keys) };
      case 'rescan':
        return { content: await this.rescan() };
      case 'help':
        return { content: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE };
    }
  }

  /** Deliver a channel answer into a bot's blocked question dialog. Pending
   *  state is NOT cleared here — the transcript watcher clears it when the
   *  tool_result lands (ground truth), and posts the confirmation. */
  async answer(target: string, spec: string): Promise<string> {
    const entry = this.registry.findAlive(target);
    if (!entry) return `No running bot matches \`${target}\` — try \`list\`.`;
    const pending = entry.pendingQuestion;
    if (!pending) {
      return `**${entry.personaName}** has no pending question I know of — \`rescan\` if you think it's stuck on one.`;
    }
    const parsed = parseAnswerSpec(spec, pending.questions[0]);
    if (parsed.kind === 'error') return `Can't parse that answer: ${parsed.error}\n(${USAGE.split('\n').find((l) => l.includes('answer'))})`;
    try {
      const warning = await injectAnswer(entry.tmuxSession, pending, parsed);
      if (pending.questions[0].kind === 'permission') {
        // Permission prompts resolve pane-side; remember what we sent so the
        // resolution notice can say approved vs denied.
        const label =
          parsed.kind === 'esc' ? 'Esc' : parsed.kind === 'digits' ? pending.questions[0].options[parsed.nums[0] - 1]?.label ?? String(parsed.nums[0]) : '?';
        this.registry.update(entry, { pendingQuestion: { ...pending, answeredWith: label } });
      }
      const what = parsed.kind === 'esc' ? 'Dismissal' : 'Answer';
      return `${what} sent to **${entry.personaName}** — I'll confirm here once its session registers it.${warning ? `\nℹ️ ${warning}` : ''}`;
    } catch (err) {
      return `Could not deliver the answer to **${entry.personaName}**: ${(err as Error).message}`;
    }
  }

  /** Raw keystrokes into a bot's terminal — the escape hatch for any dialog
   *  the parser doesn't recognise (or a stuck prompt). No detection, no
   *  verification beyond "the session exists"; `peek` shows the result. */
  async press(target: string, keys: string[]): Promise<string> {
    const entry = this.registry.findAlive(target);
    if (!entry) return `No running bot matches \`${target}\` — try \`list\`.`;
    const sent: string[] = [];
    for (const raw of keys) {
      const named = KEY_NAMES[raw.toLowerCase()];
      if (named) await sendKeys(entry.tmuxSession, named);
      else if (/^\d$/.test(raw)) await sendKeys(entry.tmuxSession, raw);
      else await sendText(entry.tmuxSession, raw);
      sent.push(named ?? raw);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (entry.pendingQuestion) {
      this.registry.update(entry, { pendingQuestion: { ...entry.pendingQuestion, answeredWith: `keys ${sent.join(' ')}` } });
    }
    return `Sent ${sent.map((k) => `\`${k}\``).join(' ')} to **${entry.personaName}** — \`peek ${entry.suffix}\` to see what it did.`;
  }

  /** Manual pane sweep over all running bots for open question dialogs (an
   *  open dialog leaves no transcript trace, so this is the recovery path for
   *  anything the periodic sweep mishandled). */
  private async rescan(): Promise<string> {
    const alive = this.registry.alive();
    if (alive.length === 0) return 'No bots running.';
    const lines = await this.watcher.rescanDialogs();
    return lines.length
      ? `Scanned ${alive.length} bot(s):\n${lines.join('\n')}`
      : `Scanned ${alive.length} bot(s) — no open question dialogs.`;
  }

  private async spawn(inv: Invocation, cmd: Command & { kind: 'spawn' }): Promise<string> {
    if (!inv.guildId) return 'Spawner commands only work in a guild channel.';
    const aliveCount = this.registry.alive().length;
    if (aliveCount >= this.config.maxSessions) {
      return `At capacity (${aliveCount}/${this.config.maxSessions} bots). \`stop\` one first.`;
    }

    // Identity carries the model, matching fleet convention (<Name><modelVersion>,
    // Sonnet5…): Claude-Code-<model>-<suffix>. NB this makes revival
    // model-specific — same name + same model revives, a different model is a
    // different persona.
    const suffix = cmd.friendly ?? (await this.freshSuffix());
    const modelPart = modelSlug(cmd.model);
    const prefix = cmd.engine === 'codex' ? 'Codex' : 'Claude-Code';
    let personaName = `${prefix}-${modelPart}-${suffix}`;
    let tmuxSession = `cc-${modelPart}-${suffix}`.toLowerCase();
    const credsFor = (name: string) => join(PORTAL_DIR, `${slugPersonaName(name)}.creds.json`);

    // Legacy identities were minted from bare family aliases (Claude-Code-
    // fable-<x>, before those were retired). An explicit version of the same
    // family revives them — nothing else can, and the name stays theirs.
    let legacy = false;
    if (cmd.friendly && !existsSync(credsFor(personaName))) {
      const family = modelPart.split('-')[0];
      const legacyName = `${prefix}-${family}-${suffix}`;
      if (family !== modelPart && existsSync(credsFor(legacyName))) {
        personaName = legacyName;
        tmuxSession = `cc-${family}-${suffix}`.toLowerCase();
        legacy = true;
      }
    }

    // The suffix stays the unique handle across the fleet, so `stop <suffix>`
    // is never ambiguous even when the same name is reused on another model.
    const clash = this.registry.findAlive(suffix);
    if (clash) {
      return `\`${suffix}\` is taken by **${clash.personaName}** (${clash.model}) — \`stop ${suffix}\` first, or spawn without a name for a fresh bot.`;
    }
    if (await hasSession(tmuxSession)) {
      return `tmux session \`${tmuxSession}\` already exists outside my registry — pick another name or clean it up.`;
    }

    const launcher = this.launchers.get(cmd.engine);
    if (!launcher) return `Engine \`${cmd.engine}\` is not available on this spawner.`;

    // Access comes from the invite the persona enrols with: mint one scoped to
    // exactly this channel, then enrol with it, so the relay writes the right
    // policy itself. No post-hoc permissions edit exists to be clobbered.
    //
    // Revival is the exception — cached creds mean no enrolment happens, so the
    // persona keeps the policy from its ORIGINAL channel. Reviving elsewhere
    // would produce a mute bot, so refuse it with something actionable.
    const credsPath = credsFor(personaName);
    const reviving = existsSync(credsPath);
    const prior = reviving
      ? [...this.registry.all()].reverse().find((e) => e.personaName === personaName)
      : undefined;
    if (reviving) {
      if (prior && prior.channelId !== inv.channelId) {
        return `**${personaName}** already exists and is scoped to <#${prior.channelId}> — reviving it here would leave it mute (its access came from that channel's invite). Spawn a fresh name here, or have an admin \`/add\` it to this channel.`;
      }
    }

    let personaId: string;
    try {
      const code = reviving
        ? undefined // cached creds; nothing to enrol, nothing to mint
        : await this.grants.mintForChannel(inv.guildId, inv.channelId, personaName);
      ({ personaId } = await launcher.enroll(personaName, code));
    } catch (err) {
      return `Could not prepare **${personaName}**: ${(err as Error).message}\nNothing was started — a bot with no access to this channel is worse than no bot.`;
    }

    // Continuity: a revival should bring back the MIND, not just the name and
    // face. We assign the Claude Code conversation id ourselves at first launch
    // and --resume it thereafter, so one persona keeps one durable transcript.
    // If that transcript is gone, say so rather than silently starting amnesiac.
    const priorSession = prior?.sessionId;
    // Codex keeps its own rollouts; `codex resume <id>` fails loudly if one is
    // gone, so trust the recorded id and let the launch report it.
    const transcript = priorSession && cmd.engine === 'claude' ? this.transcriptPath(priorSession) : undefined;
    const canResume = cmd.engine === 'codex' ? Boolean(priorSession) : Boolean(transcript && existsSync(transcript));
    const sessionId = canResume ? priorSession! : randomUUID();
    const lostContext = Boolean(priorSession) && !canResume;

    const seedCtx = {
      personaName,
      model: cmd.model,
      engine: cmd.engine,
      channelId: inv.channelId,
      threadId: inv.threadId,
      guildId: inv.guildId,
      spawnedByUsername: inv.invoker.name,
      inactivityHours: Math.round(this.config.inactivityMs / 3_600_000),
    };
    const seedFile = canResume
      ? writeSeedFile(suffix, seedCtx, { awaySince: prior?.endReason ? `(${prior.endReason})` : undefined })
      : writeSeedFile(suffix, seedCtx);

    let result;
    try {
      result = await launcher.launch({
        personaName,
        model: cmd.model,
        seedFile,
        channelId: inv.channelId,
        tmuxSession,
        sessionId,
        resume: canResume,
      });
    } catch (err) {
      await killSession(tmuxSession);
      return `Spawn failed: ${(err as Error).message}`;
    }

    await this.client
      .subscribe(inv.channelId)
      .catch((err) => log(`subscribe ${inv.channelId} failed: ${(err as Error).message}`));

    const entry: BotEntry = {
      suffix,
      personaName,
      personaId: result.personaId,
      credsPath: result.credsPath,
      tmuxSession,
      channelId: inv.channelId,
      threadId: inv.threadId,
      guildId: inv.guildId,
      engine: cmd.engine,
      // Codex assigns its own conversation id — the launcher discovers it.
      sessionId: result.sessionId ?? (cmd.engine === 'codex' ? undefined : sessionId),
      wake: result.wake,
      model: cmd.model,
      spawnedBy: { userId: inv.invoker.id, username: inv.invoker.name },
      spawnedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      status: 'alive',
      seedFile,
      // Transcript watch starts here: fresh session ⇒ 0; a --resume appends to
      // the existing JSONL, so start at its current end (history ≠ news).
      transcriptOffset: cmd.engine === 'claude' ? (canResume ? transcriptSize(this.config.projectDir, sessionId) : 0) : undefined,
    };
    this.registry.add(entry);

    const note = result.warning ? `\n⚠️ ${result.warning}` : '';
    if (canResume) {
      const legacyNote = legacy ? ` *(legacy identity from the bare-\`${personaName.split('-')[2]}\` era, now explicitly on ${cmd.model})*` : '';
      return `Revived **${personaName}** (${cmd.model}) in tmux \`${tmuxSession}\` — same identity **and** same conversation; it still remembers its earlier work and is catching up on the channel.${legacyNote}${note}`;
    }
    const amnesia = lostContext
      ? `\n⚠️ Its previous transcript is gone, so it starts fresh — same name and Discord identity, no memory of before.`
      : '';
    return `Spawned **${personaName}** (${cmd.model}) in tmux \`${tmuxSession}\` — it should introduce itself here shortly.${amnesia}${note}`;
  }

  private list(): string {
    const alive = this.registry.alive();
    if (alive.length === 0) return 'No bots running.';
    const lines = alive.map((e) => {
      const idleMin = Math.round((Date.now() - lastActivityMs(e)) / 60_000);
      const chan = this.client.cache.getChannel(e.channelId)?.name ?? e.channelId;
      return `• **${e.personaName}** (${e.model}) — #${chan}, tmux \`${e.tmuxSession}\`, idle ${formatIdle(idleMin)}`;
    });
    return `${alive.length}/${this.config.maxSessions} bots:\n${lines.join('\n')}`;
  }

  private async stop(inv: Invocation, target: string): Promise<string> {
    const entry = this.registry.findAlive(target);
    if (!entry) return `No running bot matches \`${target}\` — try \`list\`.`;
    await killSession(entry.tmuxSession);
    this.registry.update(entry, { status: 'reaped', endReason: `stopped by @${inv.invoker.name} (${inv.invoker.id})` });
    await this.reaper.releaseChannel(entry);
    const hint = isBareFamilyAlias(entry.model)
      ? `\`spawn ${entry.model}-<version> name=${entry.suffix}\` (e.g. \`${entry.model}-5\`) revives it — bare \`${entry.model}\` is retired`
      : `\`spawn ${entry.model} name=${entry.suffix}\` revives it`;
    return `Stopped **${entry.personaName}**. Identity kept — ${hint}.`;
  }

  /**
   * Capture a spawned bot's terminal state and hand it back for private
   * delivery. Registry-only by design: these are disposable hands we started,
   * not the residents' sessions — those have a private life and are off-limits
   * to this command.
   */
  private async peek(inv: Invocation, target: string, wantLines?: number): Promise<ActionResult> {
    const entry = this.registry.findAlive(target);
    if (!entry) {
      return { content: `No running bot matches \`${target}\` — try \`list\`.`, private: true };
    }
    if (inv.via !== 'slash') {
      return {
        content: `\`peek\` delivers privately, and I can only DM through the slash surface — use \`/cc peek name:${entry.suffix}\`.`,
      };
    }
    if (!(await hasSession(entry.tmuxSession))) {
      return { content: `**${entry.personaName}**'s tmux session is gone — it'll be marked reaped on the next sweep.`, private: true };
    }
    // Default is a glanceable tail with NO attachment — a .txt Discord can't
    // preview means downloading a file to read three lines. Scrollback is only
    // captured when more lines are asked for than a pane holds.
    const want = wantLines ?? PEEK_DEFAULT_LINES;
    const pane = await capturePane(entry.tmuxSession, want > 30 ? want + 50 : 0);
    const uptime = await sessionUptime(entry.tmuxSession);
    const idleMin = Math.round((Date.now() - lastActivityMs(entry)) / 60_000);
    const lines = pane.replace(/\s+$/, '').split('\n').filter((l) => l.trim());
    const tail = lines.slice(-want).join('\n');
    const header = [
      `**${entry.personaName}** (${entry.model}) — tmux \`${entry.tmuxSession}\``,
      `up ${uptime === undefined ? '?' : formatDuration(uptime)} · last public activity ${formatIdle(idleMin)} ago · spawned by @${entry.spawnedBy.username}`,
    ].join('\n');

    if (tail.length <= PEEK_INLINE_BUDGET) {
      return { private: true, content: `${header}\n\`\`\`\n${tail}\n\`\`\`` };
    }

    // Overflow. A file Discord can't preview is worse than no file, so the
    // DEFAULT peek never produces one — it just shows fewer lines. Only an
    // explicit `lines:` request gets the full capture attached.
    const shown = tail.slice(-PEEK_INLINE_BUDGET);
    const shownLines = shown.split('\n').length;
    if (wantLines === undefined) {
      return {
        private: true,
        content: `${header}\n\`\`\`\n${shown}\n\`\`\`\n_last ${shownLines} lines — ask for more with \`lines:\`._`,
      };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      private: true,
      content: `${header}\n\`\`\`\n${shown}\n\`\`\`\n_${want} lines didn't fit inline; showing ${shownLines}, full capture attached._`,
      files: [{ name: `${entry.tmuxSession}-${stamp}.txt`, text: pane }],
    };
  }

  /** Alive bots, for the slash surface's stop-name autocomplete. */
  aliveEntries(): readonly BotEntry[] {
    return this.registry.alive();
  }

  private transcriptPath(sessionId: string): string {
    return transcriptPath(this.config.projectDir, sessionId);
  }

  private async freshSuffix(): Promise<string> {
    // tmux names are cc-<model>-<suffix> now, so match on the suffix tail
    // rather than a whole-name lookup.
    const sessions = await listSessions();
    for (let i = 0; i < 16; i++) {
      const s = randomBytes(2).toString('hex');
      if (!this.registry.findAlive(s) && !sessions.some((n) => n.endsWith(`-${s}`))) return s;
    }
    throw new Error('could not find a free suffix');
  }
}

function formatIdle(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `${h}h${minutes % 60}m`;
}
