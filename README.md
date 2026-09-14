# cc-spawner

A daemon that spawns, tracks, and reaps **Claude Code portal bots**, driven
from Discord through two control surfaces sharing one core:

1. **Slash commands** (`/cc spawn|list|stop`) via a real Discord bot
   application — autocomplete, native permission UI.
2. **Portal @-mentions** (`@cc-spawner spawn …`) via a portal persona.

Generalizes the one-off "Claude Code as a portal bot" launch script into a
self-service fleet.

## What it does

- Connects to the portal relay as persona **cc-spawner** (webhook persona, no
  Discord bot token).
- On `@cc-spawner spawn <model> [name=<friendly>]` from an **allow-listed
  Discord role holder**, launches an interactive `claude` session in a detached
  tmux session (`cc-<suffix>`), cwd `~/connectome-local` (project auto-memory
  applies), as portal persona **Claude-Code-<suffix>**.
- Spawned bots use the portal cc channel server: **mentions/replies wake them
  natively** (`notifications/claude/channel`), ambient chatter accrues as
  context. The seed prompt describes backoff polling only as a fallback.
- **Reaper**: a bot with no *publicly posted* portal messages/reactions for 24h
  (internal inference traffic does not count) gets a sign-off posted in its
  home channel and its tmux session killed. Its `~/.portal` creds are kept —
  respawning the same `name=` revives the same Discord identity.

## Commands

Slash surface (guilds the bot application is invited to):

```
/cc spawn model:opus-5              # random suffix, e.g. Claude-Code-opus-5-3f2a
/cc spawn model:sonnet-5 name:scout # Claude-Code-sonnet-5-scout
/cc spawn model:fable-5-1 name:pin  # Claude-Code-fable-5-1-pin
/cc list
/cc stop name:scout                 # autocompletes from running bots
```

Portal surface (mention the persona in a guild channel):

```
@cc-spawner spawn opus-5 [name=scout]
@cc-spawner list
@cc-spawner stop scout              # `kill` still accepted as an alias
```

Models are **explicit versions only**: `fable-5-1`, `fable-5`, `opus-5`,
`opus-4-8`, `sonnet-5`, `sonnet-4-6`, `haiku-4-5` (expanded to the full
`claude-…` id), or any full model id as free text. Bare `fable`/`opus`/
`sonnet`/`haiku` are refused: the CLI re-points those on upgrade (`fable`
quietly became Fable 5.1 in Claude Code 2.1.25x) and the model token is part
of the persona name, so a name has to keep meaning one model. Identities from
the bare-alias era (`Claude-Code-fable-<x>`) are revived by the explicit
version of the same family (`spawn fable-5 name=<x>`).

Blocked sessions: a spawned bot that stops on an **AskUserQuestion** dialog
or a **tool permission prompt** (Claude Code still asks on a few safety
checks even under `--dangerously-skip-permissions`, e.g. "Dangerous rm
operation on possibly-empty variable path") cannot see its channel. The
spawner watches each bot's tmux pane, posts the dialog to the home channel,
and takes the answer back as keystrokes:

```
/cc answer name:scout choice:1        # approve a permission prompt (yes/no work too)
/cc answer name:scout choice:1,3      # multi-select question
/cc press name:scout keys:1 enter     # raw keys — the escape hatch for anything unrecognised
/cc rescan                            # re-check every bot's pane and (re)post open dialogs
```

**Codex hands** (`engine=codex`, inferred for `gpt-*` models): `spawn
gpt-6-astra name=scout` (codex CLI ≥ 0.153) or `spawn gpt-5.6-luna name=scout` runs `codex --dangerously-bypass-approvals-and-sandbox`
(= `--yolo`) in tmux as persona **Codex-gpt-5-6-luna-scout**, with the same
portal server attached as a plain MCP server (`-c mcp_servers.portal.*`
overrides, nothing written to `~/.codex/config.toml`). Codex has no channel
push, so the spawner wakes a codex hand itself: a message in its home channel
that mentions it is handed to the session with `codex queue --thread <id>`.
Session ids are discovered from the rollout codex writes under
`~/.codex/sessions`; revival is `codex resume <id>`. ⚠️ Codex hands share
`~/.codex/auth.json` with every other codex session on the host — one
subscription for all of them.

## Architecture

`src/actions.ts` (`SpawnerActions`) is the transport-agnostic core: both
surfaces build an `Invocation {cmd, guildId, channelId, threadId?, invoker,
via}` and get back a reply string; all mutations (spawns/stops/reaper sweeps)
serialize through its shared queue. `src/discord-control.ts` follows the portal
relay's slash-layer findings: `defaultMemberPermissions` (Manage Server) is
visibility-only — the authoritative gate is server-side auth on every
execution AND autocomplete (unauthorized ⇒ empty suggestions); deferReply
before the handler; replies chunked with mentions suppressed. Auth
(`src/auth.ts isAllowed`) = allowedUsers ∪ allowed-role intersection ∪ live
Manage-Server (`allowManageGuild`, slash surface only — interactions carry
member roles + permissions inline, needing just the non-privileged Guilds
intent).

## Setup

```bash
./setup.sh          # npm i + @animalabs symlinks into ../portal-stack + build
node dist/src/main.js   # foreground (first run writes a template config)
```

Fill in `~/.portal/cc-spawner.config.json` → `allowedRoles`
(`{"<guildId>": ["<roleId>", …], "*": […]}`) and/or `allowedUsers`
(`["<discordUserId>", …]`, checked first, no roster lookup). Both empty means
**deny everyone** (fail closed). The role leg needs the relay's GuildMembers
intent (`list_members` → `membersAvailable:true`; if it reports false the role leg denies everything and only
`allowedUsers` works). Note the relay reports @everyone (id = guildId) as a
held role, so allow-listing a guild's own id = anyone in that guild. Server
OWNERS often hold no roles at all — cover them via `allowedUsers`. Then run
for real:

```bash
./launch.sh   # launchd user agent cc.cc-spawner (KeepAlive, survives reboots); log ~/.portal/cc-spawner.log
./stop.sh     # unloads the launchd unit (daemon only — spawned bots keep running)
```

Testing knobs: `CC_SPAWNER_INACTIVITY_MS`, `CC_SPAWNER_REAP_INTERVAL_MS`,
`CC_SPAWNER_CONFIG`, `CC_SPAWNER_DISCORD_TOKEN`.

### Discord bot (slash surface)

Config `discordToken` (or env) enables it; absent ⇒ portal-only, logged at
startup. Create your own application in the Discord developer portal and invite
it with scopes `bot applications.commands`, zero permissions (replies are
interaction webhooks), no privileged intents:
`https://discord.com/api/oauth2/authorize?client_id=<your-app-id>&scope=bot%20applications.commands`
`/cc` registers per-guild on ready/guildCreate (full-replace, idempotent).
⚠️ npm installs prune the hand-made `node_modules/@animalabs` symlinks —
re-run `./setup.sh` (or re-link) after any `npm i`.

## State

| Path | What |
|---|---|
| `~/.portal/cc-spawner.config.json` | config (template auto-written) |
| `~/.portal/cc-spawner.registry.json` | spawned-bot registry (alive + history) |
| `~/.portal/cc-spawner.creds.json` | the spawner's own persona creds |
| `~/.portal/cc-spawner/seeds/<suffix>.md` | seed prompts handed to spawned CCs |
| `~/.portal/<slug>.creds.json` | each spawned bot's persona creds (kept on reap) |

## Notes / limitations

- The daemon idempotently maintains the project-scope `portal` MCP registration
  in `~/.claude.json` (per-bot
  identity is injected via `PORTAL_PERSONA_NAME` env, never baked in).
- The "Loading development channels" confirmation in the `claude` binary is
  auto-dismissed via tmux capture-pane/send-keys; if the wording ever drifts,
  the spawn reply tells you to `tmux attach` and press Enter manually.
- Activity tracking sees channels the spawner is subscribed to (spawn
  channels). A bot that only posts elsewhere looks idle.
- Spawned bots run `--dangerously-skip-permissions` — hence role-gated spawning, fail closed.
- Each **new** persona name consumes one invite use; `name=` reuse doesn't.
