/**
 * cc-spawner daemon — spawns/reaps Claude Code portal bots. Two control
 * surfaces share one SpawnerActions core:
 *  - portal @-mentions (this file wires it)
 *  - Discord slash commands /cc spawn|list|stop (discord-control.ts, enabled
 *    when a bot token is configured)
 * See README.md.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PortalClient, loadOrEnrollCreds } from '@animalabs/portal-client';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { SpawnerActions, type Invocation } from './actions.js';
import { PortalRoleFetcher } from './auth.js';
import { buildAnswerCommand, parseCommand } from './commands.js';
import { CREDS_PATH, loadConfig, type SpawnerConfig } from './config.js';
import { DiscordControl } from './discord-control.js';
import { ChannelInviteMinter } from './grants.js';
import { ClaudeCodeLauncher, CodexLauncher, type Launcher } from './launcher.js';
import { Reaper } from './reaper.js';
import { Registry } from './registry.js';
import { TranscriptWatcher } from './transcript-watch.js';

const run = promisify(execFile);
const log = (msg: string) => console.log(`${new Date().toISOString()} [spawner] ${msg}`);

class SpawnerDaemon {
  private readonly registry = new Registry();
  private readonly launchers = new Map<string, Launcher>();
  private client!: PortalClient;
  private roleFetcher!: PortalRoleFetcher;
  private actions!: SpawnerActions;
  private reaper!: Reaper;
  private watcher!: TranscriptWatcher;
  private discord?: DiscordControl;
  private processedPings = new Set<string>();

  constructor(private readonly config: SpawnerConfig) {
    const cc = new ClaudeCodeLauncher(config);
    this.launchers.set(cc.engine, cc);
    const codex = new CodexLauncher(this.config);
    this.launchers.set(codex.engine, codex);
  }

  async start(): Promise<void> {
    this.registry.load();

    if (!this.config.invite && !existsSync(CREDS_PATH)) {
      throw new Error(
        `no portal invite configured and no cached creds at ${CREDS_PATH} — set "invite" in the config file (never in source)`,
      );
    }
    const creds = await loadOrEnrollCreds({
      url: this.config.url,
      credsPath: CREDS_PATH,
      invite: this.config.invite,
      desiredName: this.config.personaName,
    });
    log(`persona ${creds.personaId}`);

    await this.ensureMcpRegistered();

    this.client = new PortalClient({
      url: this.config.url,
      token: creds.token,
      personaId: creds.personaId,
      subscriptions: [...new Set(this.registry.alive().map((e) => e.channelId))],
    });
    this.roleFetcher = new PortalRoleFetcher(this.client);
    const grants = new ChannelInviteMinter(this.client, this.config.grants);
    this.reaper = new Reaper(this.registry, this.client, this.config);
    this.watcher = new TranscriptWatcher(this.registry, this.client, this.config);
    this.actions = new SpawnerActions(this.config, this.registry, this.launchers, this.client, this.reaper, grants, this.watcher);

    this.client.on('error', (err) => log(`client error: ${err.message}`));
    this.client.on('close', ({ code, willReconnect }) =>
      log(`portal connection closed (${code})${willReconnect ? ', reconnecting' : ''}`),
    );
    this.client.on('message', (e) => {
      this.trackActivity(e.message);
      void this.wakeCodexHands(e.message);
      // A native Discord reply to one of our question posts is an answer —
      // humans only (bots/residents are told in the post to @-mention instead,
      // which keeps the resident loop-guard semantics intact).
      if (!e.addressedToMe && e.message.replyToId) {
        const target = this.registry
          .alive()
          .find((b) => b.pendingQuestion?.messageId === e.message.replyToId);
        if (target && e.message.author.kind === 'user' && !e.message.author.bot) {
          void this.handleQuestionReply(e.message, target);
          return;
        }
      }
      if (!e.addressedToMe) return;
      const a = e.message.author;
      const fromUser = a.kind === 'user' && !a.bot;
      // Residents come in two shapes: portal personas, and discord-integration
      // bots (real bot accounts → author kind 'user' with bot:true).
      const fromResident =
        (a.kind === 'persona' && this.config.allowedResidents.includes(a.personaId)) ||
        (a.kind === 'user' && a.bot && this.config.allowedResidents.includes(a.userId));
      if (fromUser || fromResident) void this.handlePortalCommand(e.message);
    });
    this.client.on('reactionAdd', (e) => {
      for (const actor of e.reaction.by) {
        if (actor.kind === 'persona') this.bumpActivity(actor.id, undefined);
      }
    });
    this.client.on('ready', () => {
      log('portal ready');
      void this.actions.enqueue(() => this.answerStalePings());
    });

    await this.reaper.reconcile();
    this.registry.save();
    await this.client.connect();
    log(`connected to ${this.config.url} as ${this.config.personaName}`);

    // Discord slash surface — optional, isolated from the portal leg.
    if (this.config.discordToken) {
      this.discord = new DiscordControl(this.actions, this.config);
      this.discord.start(this.config.discordToken).catch((err) => {
        log(`discord control failed to start: ${(err as Error).message} — continuing portal-only`);
        this.discord = undefined;
      });
    } else {
      log('discord control disabled (no discordToken / CC_SPAWNER_DISCORD_TOKEN)');
    }

    setInterval(() => void this.actions.enqueue(() => this.reaper.sweep()), this.config.reapIntervalMs);
    // Transcript watch is read-only over registry state the queue also touches
    // (offset persistence) — serialize it through the same queue as the reaper.
    setInterval(() => void this.actions.enqueue(() => this.watcher.sweep()), this.config.watchIntervalMs);

    const shutdown = (sig: string) => {
      log(`${sig} — shutting down (spawned bots keep running)`);
      this.registry.save();
      this.discord?.stop();
      this.client.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // ── Portal transport ──

  private async handlePortalCommand(m: PortalMessage): Promise<void> {
    const cmd = parseCommand(m.cleanContent);
    let invoker: Invocation['invoker'];
    if (m.author.kind === 'user' && !m.author.bot) {
      const roles = m.guildId
        ? await this.roleFetcher.fetch(m.guildId, m.author.userId, m.author.username)
        : undefined;
      invoker = { id: m.author.userId, name: m.author.username, kind: 'user', roles };
    } else if (m.author.kind === 'persona' || m.author.kind === 'user') {
      // Resident (portal persona OR discord-integration bot account).
      // Loop guard: two bots exchanging replies must not ping-pong. Residents
      // get replies only for real commands — conversational text that parses
      // to help/unknown is ignored silently (logged only).
      const id = m.author.kind === 'persona' ? m.author.personaId : m.author.userId;
      const name = m.author.kind === 'persona' ? m.author.displayName : m.author.username;
      if (cmd.kind === 'help') {
        log(`ignoring non-command mention from resident ${id}: ${JSON.stringify(m.cleanContent.slice(0, 120))}`);
        return;
      }
      invoker = { id, name, kind: 'resident' };
    } else {
      return;
    }
    const inv: Invocation = {
      cmd,
      guildId: m.guildId,
      channelId: m.channelId,
      threadId: m.threadId,
      invoker,
      via: 'portal',
    };
    const result = await this.actions.run(inv);
    // Portal has no DM channel (deliberately unported), so anything the core
    // marked private must not be posted in-channel — point at the slash surface.
    const content = result.private && result.files?.length
      ? 'That reply is private and carries an attachment — use the `/cc` slash command so I can DM it to you.'
      : result.content;
    await this.reply(m, content);
  }

  /** A reply to a pending-question post — route it through the normal answer
   *  command (same auth, same queue) with the reply body as the spec. */
  private async handleQuestionReply(m: PortalMessage, entry: { suffix: string }): Promise<void> {
    if (m.author.kind !== 'user' || m.author.bot) return;
    const spec = m.cleanContent.trim();
    if (!spec) return;
    const roles = m.guildId
      ? await this.roleFetcher.fetch(m.guildId, m.author.userId, m.author.username)
      : undefined;
    const inv: Invocation = {
      cmd: buildAnswerCommand(entry.suffix, spec),
      guildId: m.guildId,
      channelId: m.channelId,
      threadId: m.threadId,
      invoker: { id: m.author.userId, name: m.author.username, kind: 'user', roles },
      via: 'portal',
    };
    const result = await this.actions.run(inv);
    await this.reply(m, result.content);
  }

  /** Commands that arrived while the daemon was down: never execute stale
   *  spawns. Mark the actual delivery container read (a thread when present),
   *  then post at most one bounded notice per container. Portal pings are
   *  durable; replying once per historical command turns a reconnect into a
   *  channel flood, and marking only the parent leaves thread pings pending. */
  private async answerStalePings(): Promise<void> {
    let pings;
    try {
      ({ pings } = await this.client.call('get_pending_pings', {}));
    } catch (err) {
      log(`get_pending_pings failed: ${(err as Error).message}`);
      return;
    }

    const containers = new Set<string>();
    const staleByContainer = new Map<string, { count: number; latest: PortalMessage }>();
    for (const ping of pings) {
      const m = ping.message;
      const containerId = m.threadId ?? m.channelId;
      containers.add(containerId);
      if (this.processedPings.has(m.id) || m.author.kind !== 'user') continue;
      this.processedPings.add(m.id);
      const cmd = parseCommand(m.cleanContent);
      if (cmd.kind !== 'spawn' && cmd.kind !== 'stop') continue;
      const batch = staleByContainer.get(containerId);
      if (batch) {
        batch.count += 1;
        if (m.createdAt > batch.latest.createdAt) batch.latest = m;
      } else {
        staleByContainer.set(containerId, { count: 1, latest: m });
      }
    }

    // Advance the durable watermark before speaking. If a later reply fails,
    // silence is safer than replaying the whole stale backlog next restart.
    for (const channelId of containers) {
      await this.client.call('mark_read', { channelId }).catch((err) =>
        log(`mark_read ${channelId} failed: ${(err as Error).message}`),
      );
    }

    for (const { count, latest } of staleByContainer.values()) {
      const noun = count === 1 ? 'command' : `${count} commands`;
      await this.reply(
        latest,
        `I was offline while ${noun} arrived here — I ignored ${count === 1 ? 'it' : 'them'}. Re-issue anything still wanted.`,
      );
    }
  }

  // ── Activity tracking (PUBLIC portal traffic only) ──

  private trackActivity(m: PortalMessage): void {
    if (m.author.kind !== 'persona') return;
    this.bumpActivity(m.author.personaId, m.author.displayName);
  }

  private bumpActivity(personaId: string, displayName?: string): void {
    const entry =
      this.registry.byPersonaId(personaId) ??
      (displayName ? this.registry.alive().find((e) => e.personaName === displayName) : undefined);
    if (entry) this.registry.update(entry, { lastActivity: new Date().toISOString() });
  }

  // ── Helpers ──

  private async reply(m: PortalMessage, content: string): Promise<void> {
    try {
      await this.client.sendMessage({ channelId: m.channelId, threadId: m.threadId, content, replyToId: m.id });
    } catch (err) {
      log(`reply to ${m.channelId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * LEGACY codex wake — home channel only, mentions only. Hands launched since
   * the wake sidecar exist (entry.wake === 'cc-cli') are woken by their own
   * portal server instead (portal-mcpl cc-cli, PORTAL_WAKE=codex): guild-wide,
   * mentions AND replies, straight from the relay's addressed deliveries. This
   * path stays for hands that booted on the old cc-cli and haven't been revived.
   */
  private async wakeCodexHands(m: PortalMessage): Promise<void> {
    const authorPersona = m.author.kind === 'persona' ? m.author.personaId : undefined;
    const targets = this.registry
      .alive()
      .filter(
        (b) =>
          b.engine === 'codex' &&
          b.wake !== 'cc-cli' &&
          b.sessionId &&
          b.channelId === m.channelId &&
          b.personaId !== authorPersona &&
          m.mentions.personas.includes(b.personaId),
      );
    for (const b of targets) {
      const who =
        m.author.kind === 'user' ? `@${m.author.username}` : m.author.kind === 'persona' ? m.author.displayName : 'someone';
      const where = m.threadId ? `thread ${m.threadId} (channel ${m.channelId})` : `channel ${m.channelId}`;
      const text =
        `${who} mentioned you in ${where}: ${m.cleanContent.slice(0, 1500)}\n` +
        `(delivered by cc-spawner — read the backscroll with the portal tools and reply there with send_message)`;
      try {
        await run(this.config.codexBin, ['queue', '--thread', b.sessionId!, '--message', text]);
        log(`woke codex hand ${b.personaName} for a mention by ${who}`);
      } catch (err) {
        log(`codex queue for ${b.personaName} failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }

  /**
   * Idempotently ensure the project-scope `portal` MCP registration that
   * spawned CC sessions resolve their channel server through. Registering once
   * here (instead of per-launch) avoids concurrent
   * spawns racing on ~/.claude.json.
   */
  private async ensureMcpRegistered(): Promise<void> {
    const claudeJson = join(homedir(), '.claude.json');
    let current: { command?: string; args?: string[]; env?: Record<string, string> } | undefined;
    if (existsSync(claudeJson)) {
      try {
        const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
          projects?: Record<string, { mcpServers?: Record<string, typeof current> }>;
        };
        current = parsed.projects?.[this.config.projectDir]?.mcpServers?.portal;
      } catch {
        /* unreadable — fall through to re-register */
      }
    }
    const ok =
      current?.command === 'node' &&
      current.args?.length === 1 &&
      current.args[0] === this.config.ccCli &&
      current.env?.PORTAL_URL === this.config.url &&
      current.env?.PORTAL_INVITE === this.config.invite &&
      current.env?.PORTAL_PERSONA_NAME === undefined; // per-launch env must stay in charge
    if (ok) {
      log('portal MCP registration OK');
      return;
    }
    log('(re)registering portal MCP server at project scope');
    const cwd = this.config.projectDir;
    await run('claude', ['mcp', 'remove', '-s', 'local', 'portal'], { cwd }).catch(() => undefined);
    await run(
      'claude',
      [
        'mcp', 'add', '-s', 'local', 'portal',
        '-e', `PORTAL_URL=${this.config.url}`,
        '-e', `PORTAL_INVITE=${this.config.invite}`,
        '--', 'node', this.config.ccCli,
      ],
      { cwd },
    );
  }
}

// ── Entry point ──

const config = loadConfig();
new SpawnerDaemon(config).start().catch((err) => {
  console.error(`${new Date().toISOString()} [spawner] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
