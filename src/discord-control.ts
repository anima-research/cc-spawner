/**
 * Discord slash-command control surface — a real Discord bot application
 * (separate from the portal relay bot) exposing /cc spawn|list|stop.
 *
 * Modeled on portal-relay's slash layer (discord-bot.ts) and its review
 * findings:
 *  - defaultMemberPermissions is UX ONLY — the authoritative gate is
 *    SpawnerActions' server-side auth (allowedUsers / allowedRoles /
 *    ManageGuild), re-checked on every execution.
 *  - Autocomplete is gated identically to execution (unauthorized ⇒ []), and
 *    truncated to Discord's hard cap of 25 choices.
 *  - deferReply BEFORE running the handler (3s ACK window → 15min), replies
 *    chunked under the 2000-char limit, allowedMentions never parse.
 *  - Guild-scoped registration via app.commands.set(data, guildId) — full
 *    replace, idempotent, re-run on ready + guildCreate.
 *
 * Needs only the Guilds intent (non-privileged): member roles + the
 * ManageGuild bit arrive inline on every interaction payload.
 */
import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import type { SpawnerActions, Invocation } from './actions.js';
import { CODEX_MODEL_CHOICES, MODEL_CHOICES, buildAnswerCommand, buildPeekCommand, buildPressCommand, buildSpawnCommand, buildStopCommand, type Command } from './commands.js';
import type { SpawnerConfig } from './config.js';
import type { Invoker } from './auth.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [discord] ${msg}`);

// Explicit version names (MODEL_ALIASES in commands.ts); full ids like
// claude-fable-5-1 also work and are accepted as free text. Bare family
// aliases are retired — see commands.ts.
const MODEL_SUGGESTIONS = [...MODEL_CHOICES, ...CODEX_MODEL_CHOICES];

const CC_COMMAND = {
  name: 'cc',
  description: 'Claude Code spawner — spawn/list/stop CC portal bots',
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild, // visibility only
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'spawn',
      description: 'Spawn a Claude Code bot in this channel (model required)',
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'model',
          description: 'Explicit model: fable-5-1, fable-5, opus-5, sonnet-5, gpt-5.6-luna (codex) … or a full id',
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'name',
          description: 'Friendly name (re-using a name revives the same identity)',
          required: false,
        },
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'engine',
          description: 'claude (default; inferred from the model) or codex',
          required: false,
          choices: [
            { name: 'claude', value: 'claude' },
            { name: 'codex', value: 'codex' },
          ],
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'list',
      description: 'List running bots',
    },
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'peek',
      description: "DM yourself a bot's terminal tail (last 20 lines by default)",
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'name',
          description: 'Which bot to look at',
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.Integer as const,
          name: 'lines',
          description: 'How many lines (default 20; over ~40 may arrive as a file)',
          required: false,
          min_value: 1,
          max_value: 400,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'answer',
      description: "Answer a bot's pending question or permission prompt",
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'name',
          description: 'Which bot to answer',
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'choice',
          description: 'A number (2), several (1,3), yes/no for permission prompts, text: …, or esc',
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'press',
      description: "Send raw keystrokes to a bot's terminal to unstick it (e.g. keys: 1 enter)",
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'name',
          description: 'Which bot',
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'keys',
          description: 'Space-separated: digits, enter, esc, tab, up/down, ctrl-c, or literal text',
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'rescan',
      description: 'Re-check running bots for an open question/permission dialog and (re)post it',
    },
    {
      type: ApplicationCommandOptionType.Subcommand as const,
      name: 'stop',
      description: 'Stop a bot (its identity is kept for revival)',
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: 'name',
          description: 'Bot to stop (friendly name, suffix, or persona name)',
          required: true,
          autocomplete: true,
        },
      ],
    },
  ],
};

export class DiscordControl {
  private client?: Client;

  constructor(
    private readonly actions: SpawnerActions,
    private readonly config: SpawnerConfig,
  ) {}

  async start(token: string): Promise<void> {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client = client;

    client.on(Events.ClientReady, () => {
      log(`logged in as ${client.user?.tag} — registering /cc in ${client.guilds.cache.size} guild(s)`);
      for (const guild of client.guilds.cache.values()) void this.register(guild);
    });
    client.on(Events.GuildCreate, (guild) => {
      log(`joined guild ${guild.name} (${guild.id})`);
      void this.register(guild);
    });
    client.on(Events.Error, (err) => log(`client error: ${err.message}`));

    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) {
        void this.onAutocomplete(interaction).catch((err) => log(`autocomplete error: ${(err as Error).message}`));
        return;
      }
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'cc') return;
      void this.onCommand(interaction).catch((err) => log(`interaction error: ${(err as Error).stack ?? err}`));
    });

    await client.login(token);
  }

  stop(): void {
    void this.client?.destroy();
  }

  private async register(guild: Guild): Promise<void> {
    try {
      const app = this.client?.application;
      if (!app) return;
      await app.commands.set([CC_COMMAND], guild.id);
      log(`registered /cc in ${guild.name} (${guild.id})`);
    } catch (err) {
      log(`command registration failed for ${guild.id}: ${(err as Error).message}`);
    }
  }

  /** Roles arrive inline on the interaction; uncached members carry a raw
   *  string[] while cached ones carry a GuildMemberRoleManager. */
  private invokerOf(interaction: ChatInputCommandInteraction | AutocompleteInteraction): Invoker {
    const m = interaction.member;
    const rawRoles = m?.roles;
    const roles =
      rawRoles === undefined || rawRoles === null
        ? undefined
        : Array.isArray(rawRoles)
          ? rawRoles
          : [...rawRoles.cache.keys()];
    return {
      id: interaction.user.id,
      name: interaction.user.username,
      roles,
      hasManageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    };
  }

  /** channelId/threadId in the shape the portal side records: threads resolve
   *  to parent channel + thread id. */
  private spawnContext(interaction: ChatInputCommandInteraction | AutocompleteInteraction): {
    channelId: string;
    threadId?: string;
  } {
    const ch = interaction.channel;
    if (ch && 'isThread' in ch && ch.isThread() && ch.parentId) {
      return { channelId: ch.parentId, threadId: ch.id };
    }
    return { channelId: interaction.channelId ?? '' };
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.channelId) return; // no DMs
    // Defer BEFORE the handler: spawn awaits enroll + tmux + a 90s-max
    // handshake — far past the 3s raw-reply window. Public (non-ephemeral):
    // spawn/stop results are a useful audit trail in the channel.
    const sub = interaction.options.getSubcommand();
    // A peek is for the caller's eyes only — never let it land in the channel.
    await interaction.deferReply(sub === 'peek' ? { flags: MessageFlags.Ephemeral } : {});
    let cmd: Command;
    switch (sub) {
      case 'spawn':
        cmd = buildSpawnCommand(
          interaction.options.getString('model') ?? undefined,
          interaction.options.getString('name') ?? undefined,
          interaction.options.getString('engine') ?? undefined,
        );
        break;
      case 'list':
        cmd = { kind: 'list' };
        break;
      case 'stop':
        cmd = buildStopCommand(interaction.options.getString('name') ?? undefined);
        break;
      case 'peek':
        cmd = buildPeekCommand(
          interaction.options.getString('name') ?? undefined,
          interaction.options.getInteger('lines') ?? undefined,
        );
        break;
      case 'answer':
        cmd = buildAnswerCommand(
          interaction.options.getString('name') ?? undefined,
          interaction.options.getString('choice') ?? undefined,
        );
        break;
      case 'press':
        cmd = buildPressCommand(
          interaction.options.getString('name') ?? undefined,
          interaction.options.getString('keys') ?? undefined,
        );
        break;
      case 'rescan':
        cmd = { kind: 'rescan' };
        break;
      default:
        cmd = { kind: 'help' };
    }

    const inv: Invocation = {
      cmd,
      guildId: interaction.guildId,
      ...this.spawnContext(interaction),
      invoker: this.invokerOf(interaction),
      via: 'slash',
    };
    const result = await this.actions.run(inv);

    if (result.private) {
      const files = (result.files ?? []).map(
        (f) => new AttachmentBuilder(Buffer.from(f.text, 'utf8'), { name: f.name }),
      );
      try {
        await interaction.user.send({ content: result.content, files, allowedMentions: { parse: [] } });
        await interaction.editReply({ content: '📬 Sent you a DM.', allowedMentions: { parse: [] } });
      } catch (err) {
        // DMs closed / blocked — fall back to the ephemeral reply, which only
        // the caller can see anyway.
        log(`DM to ${interaction.user.username} failed: ${(err as Error).message}`);
        const chunks = splitContent(result.content, 1900);
        await interaction.editReply({
          content: `⚠️ Couldn't DM you (DMs closed?) — here it is privately instead.\n\n${chunks[0]}`,
          files,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    const chunks = splitContent(result.content, 1900);
    await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
    for (const extra of chunks.slice(1)) {
      await interaction.followUp({ content: extra, allowedMentions: { parse: [] } });
    }
  }

  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== 'cc' || !interaction.guildId) return interaction.respond([]);
    // Gate identically to execution: an unauthorized user typing in a visible
    // option field must not be able to enumerate running bots.
    if (!this.actions.authorized({ invoker: this.invokerOf(interaction), guildId: interaction.guildId })) {
      return interaction.respond([]);
    }
    const focused = interaction.options.getFocused(true);
    const partial = focused.value.toLowerCase();
    let values: string[] = [];
    if (focused.name === 'model') {
      values = MODEL_SUGGESTIONS.filter((v) => v.startsWith(partial));
      // Free text is allowed — echo the typed value so it's selectable.
      if (focused.value && !values.includes(focused.value)) values.push(focused.value);
    } else if (focused.name === 'name' && ['stop', 'peek', 'answer', 'press'].includes(interaction.options.getSubcommand())) {
      // For answer/press, bots actually blocked on a dialog come first.
      const entries =
        ['answer', 'press'].includes(interaction.options.getSubcommand())
          ? [...this.actions.aliveEntries()].sort((a, b) => Number(!!b.pendingQuestion) - Number(!!a.pendingQuestion))
          : this.actions.aliveEntries();
      values = entries.map((e) => e.suffix).filter((s) => s.toLowerCase().includes(partial));
    }
    await interaction.respond(values.slice(0, 25).map((v) => ({ name: v, value: v })));
  }
}

/** Chunk on line boundaries under Discord's 2000-char cap (relay pattern);
 *  never returns an empty array (empty content is a 400). */
function splitContent(content: string, limit: number): string[] {
  if (content.length <= limit) return [content.length > 0 ? content : '(empty)'];
  const out: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    // Hard-wrap a single oversized line.
    let rest = line;
    while (rest.length > limit) {
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }
  if (current) out.push(current);
  return out.length > 0 ? out : ['(empty)'];
}
