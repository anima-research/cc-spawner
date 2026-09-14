/**
 * Spawner configuration — ~/.portal/cc-spawner.config.json + env overrides.
 *
 * Fail-closed by design: a missing/empty `allowedRoles` map means NOBODY can
 * drive the spawner. A template config is written on first run so the operator
 * has something concrete to fill in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GrantConfig } from './grants.js';

export interface SpawnerConfig {
  /** Portal relay websocket URL. */
  url: string;
  /** Invite used to enroll the spawner persona AND baked into the project MCP
   *  registration for spawned bots (their personas enroll through it too). */
  invite: string;
  /** The spawner's own portal persona name. */
  personaName: string;
  /**
   * Guilds the spawner may be driven from at all. Checked BEFORE every other
   * auth leg (users, residents, roles, Manage-Server), and the slash layer
   * only registers /cc in these guilds. Empty/missing ⇒ deny everywhere
   * (fail closed): otherwise anyone who adds the bot application to their
   * own guild and holds Manage Server there could list/peek/stop hands.
   */
  allowedGuilds: string[];
  /**
   * Discord-role-based authorization: guildId → role ids whose holders may
   * drive the spawner. Key "*" is a global list unioned into every guild.
   * Empty/missing ⇒ deny (fail closed).
   * NB: the relay includes the @everyone pseudo-role (id = guildId) in member
   * role lists — allow-listing a guild's own id means "anyone in the guild".
   */
  allowedRoles: Record<string, string[]>;
  /**
   * Discord user ids allowed unconditionally (checked BEFORE the role lookup,
   * so it works even if the relay's GuildMembers intent goes away again).
   */
  allowedUsers: string[];
  /**
   * RESIDENT agents allowed to drive the spawner via @-mention, so they can
   * summon/dismiss their own CC hands. One list, two id spaces: portal persona
   * ids (portal-connected residents) and Discord bot-account user ids
   * (discord-integration residents — most of the fleet). Spawned Claude-Code-*
   * personas are structurally excluded (no recursion) even if listed here.
   */
  allowedResidents: string[];
  /** Treat Discord Manage-Server as authorized on the slash surface (portal
   *  mentions can't evaluate it). Relay slash-command semantics. */
  allowManageGuild: boolean;
  /**
   * Bot token for the Discord slash-command control surface (/cc). Absent ⇒
   * that surface is disabled and the spawner is portal-mention-only.
   * Env override: CC_SPAWNER_DISCORD_TOKEN.
   */
  discordToken?: string;
  /** Max concurrently alive spawned bots. */
  maxSessions: number;
  /** Reap a bot after this long without PUBLIC portal activity (default 24h). */
  inactivityMs: number;
  /** Reaper sweep interval (default 10 min). */
  reapIntervalMs: number;
  /** Transcript-watch sweep interval (default 20s) — how often spawned bots'
   *  session JSONLs are checked for classifier fallbacks / compaction. */
  watchIntervalMs: number;
  /** cwd for spawned Claude Code sessions (project auto-memory lives here). */
  projectDir: string;
  /** portal-mcpl cc channel server entry (node script). */
  ccCli: string;
  /** codex CLI binary for engine=codex hands (PATH lookup by default). */
  codexBin: string;
  /** PORTAL_CONTEXT_CAP for spawned bots. */
  contextCap: number;
  /**
   * Per-channel access for spawned bots (least-privilege): each bot enrols
   * with a single-use invite minted for exactly its spawn channel via the
   * relay's mint_invite RPC. Disable to fall back to the static invite.
   */
  grants: GrantConfig;
}

const HOME = homedir();
export const PORTAL_DIR = join(HOME, '.portal');
export const SPAWNER_DIR = join(PORTAL_DIR, 'cc-spawner');
export const SEEDS_DIR = join(SPAWNER_DIR, 'seeds');
export const REGISTRY_PATH = join(PORTAL_DIR, 'cc-spawner.registry.json');
export const CREDS_PATH = join(PORTAL_DIR, 'cc-spawner.creds.json');

const DEFAULTS: SpawnerConfig = {
  url: 'wss://portal.animalabs.ai',
  invite: '', // set in ~/.portal/cc-spawner.config.json — never in source
  personaName: 'cc-spawner',
  allowedGuilds: [],
  allowedRoles: {},
  allowedUsers: [],
  allowedResidents: [],
  allowManageGuild: true,
  maxSessions: 30,
  inactivityMs: 24 * 60 * 60 * 1000,
  reapIntervalMs: 10 * 60 * 1000,
  watchIntervalMs: 20 * 1000,
  projectDir: join(HOME, 'connectome-local'),
  ccCli: join(HOME, 'connectome-local/portal-stack/portal-mcpl/dist/src/cc-cli.js'),
  codexBin: 'codex',
  contextCap: 80,
  grants: {
    enabled: true,
    expiresInMinutes: 15,
    // Standard agent caps + threads/files. Deliberately NOT MANAGE_MESSAGES —
    // a disposable hand has no business deleting other people's messages.
    // Must be a subset of what cc-spawner itself holds on the channel.
    caps: [
      'VIEW_CHANNEL',
      'READ_HISTORY',
      'SEND_MESSAGES',
      'SEND_IN_THREADS',
      'CREATE_THREADS',
      'ATTACH_FILES',
      'ADD_REACTIONS',
      'EDIT_OWN',
      'DELETE_OWN',
    ],
  },
};

export function configPath(): string {
  return process.env.CC_SPAWNER_CONFIG ?? join(PORTAL_DIR, 'cc-spawner.config.json');
}

export function loadConfig(): SpawnerConfig {
  const path = configPath();
  let fileCfg: Partial<SpawnerConfig> = {};
  if (existsSync(path)) {
    fileCfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<SpawnerConfig>;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
    console.warn(`[config] wrote template config to ${path} — fill in allowedRoles (currently deny-all)`);
  }
  const cfg: SpawnerConfig = { ...DEFAULTS, ...fileCfg };

  // Env overrides (testing knobs).
  const envNum = (name: string, current: number): number => {
    const raw = process.env[name];
    if (!raw) return current;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${name}: ${raw}`);
    return n;
  };
  cfg.inactivityMs = envNum('CC_SPAWNER_INACTIVITY_MS', cfg.inactivityMs);
  cfg.reapIntervalMs = envNum('CC_SPAWNER_REAP_INTERVAL_MS', cfg.reapIntervalMs);
  cfg.watchIntervalMs = envNum('CC_SPAWNER_WATCH_INTERVAL_MS', cfg.watchIntervalMs);
  if (process.env.CC_SPAWNER_DISCORD_TOKEN) cfg.discordToken = process.env.CC_SPAWNER_DISCORD_TOKEN;

  if (!existsSync(cfg.ccCli)) {
    throw new Error(`ccCli not built at ${cfg.ccCli} — (cd portal-stack/portal-mcpl && npm i && npm run build)`);
  }
  if (cfg.allowedGuilds.length === 0) {
    console.warn('[config] allowedGuilds is empty — ALL commands will be denied and /cc will not be registered anywhere until it is populated');
  }
  const anyRoles = Object.values(cfg.allowedRoles).some((r) => r.length > 0);
  if (!anyRoles && cfg.allowedUsers.length === 0) {
    console.warn('[config] allowedRoles and allowedUsers are empty — ALL commands will be denied until one is populated');
  }
  return cfg;
}
