/**
 * Launcher — turns a spawn request into a running agent session in tmux.
 *
 * ClaudeCodeLauncher reproduces the single-bot portal launch recipe per bot:
 * pre-enroll the persona (so we know its personaId), then a detached tmux
 * session running interactive `claude` wired to the portal cc channel server
 * (native mention-wake), then auto-dismiss the "Loading development channels"
 * confirmation via capture-pane/send-keys.
 *
 * CodexLauncher (engine=codex) runs `codex --dangerously-bypass-approvals-and-
 * sandbox` (what `--yolo` expands to) with the SAME portal server wired in as
 * a plain MCP server via `-c mcp_servers.portal.*` overrides — verified
 * 2026-09-04 (codex 0.151.0): all 23 portal tools are callable. Codex has no
 * channel push, so the portal server itself wakes the hand (PORTAL_WAKE=codex):
 * on a mention or reply — anywhere in the guild, the relay delivers addressed
 * messages regardless of subscription — it runs `codex queue --thread <id>
 * --message …`, reading the thread id from the sidecar we write here once we
 * know it (~/.portal/<personaId>.wake.json). Codex assigns its own session id,
 * so we discover it from the rollout file it writes under ~/.codex/sessions,
 * and revive with `codex resume <id>`.
 */
import { readdirSync, readFileSync, realpathSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadOrEnrollCreds } from '@animalabs/portal-client';
import { PORTAL_DIR, type SpawnerConfig } from './config.js';
import { capturePane, hasSession, newSession, sendKeys } from './tmux.js';

export interface LaunchRequest {
  personaName: string;
  model: string;
  seedFile: string;
  /** Claude Code conversation id. Assigned on a first launch, reused on revival. */
  sessionId: string;
  /** true ⇒ --resume the existing transcript instead of starting fresh. */
  resume: boolean;
  /** Home channel — seeded as the bot's durable subscription. */
  channelId: string;
  tmuxSession: string;
}

export interface LaunchResult {
  personaId: string;
  credsPath: string;
  /** Non-fatal problem the operator should hear about (e.g. manual Enter needed). */
  warning?: string;
  /** Engines that assign their own conversation id (codex) report it here;
   *  undefined means "use the id the caller chose". */
  sessionId?: string;
  /** Set when the hand's own portal server wakes it (wake sidecar written). */
  wake?: 'cc-cli';
}

export interface Launcher {
  readonly engine: string;
  /** Mint (or load) the persona's credentials WITHOUT starting anything, so the
   *  caller can grant channel permissions before the agent boots and calls
   *  fetch_history. Idempotent — launch() reuses the same cached creds. */
  enroll(personaName: string, invite?: string): Promise<{ personaId: string; credsPath: string }>;
  launch(req: LaunchRequest): Promise<LaunchResult>;
}

/** Same slug rules as portal-mcpl cc-cli.ts — the spawned process must resolve
 *  the SAME creds path we pre-enrolled into. */
export function slugPersonaName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'agent';
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared by both engines: mint (first time) or load the persona's creds. */
async function enrollPersona(
  config: SpawnerConfig,
  personaName: string,
  invite?: string,
): Promise<{ personaId: string; credsPath: string }> {
  const credsPath = join(PORTAL_DIR, `${slugPersonaName(personaName)}.creds.json`);
  const creds = await loadOrEnrollCreds({
    url: config.url,
    credsPath,
    // A channel-scoped minted code when we have one; else the static invite.
    invite: invite ?? config.invite,
    desiredName: personaName,
  });
  return { personaId: creds.personaId, credsPath };
}

const DEV_CHANNELS_PROMPT_RE = /Loading development channels|local development/i;
const HANDSHAKE_TIMEOUT_MS = 90_000;
const HANDSHAKE_POLL_MS = 2_000;
const MAX_ENTER_SENDS = 3;

export class ClaudeCodeLauncher implements Launcher {
  readonly engine = 'claude';

  constructor(private readonly config: SpawnerConfig) {}

  /** Idempotent: first call for a name consumes an invite use and mints the
   *  persona; later calls just read the cached creds ⇒ same portal identity. */
  async enroll(personaName: string, invite?: string): Promise<{ personaId: string; credsPath: string }> {
    return enrollPersona(this.config, personaName, invite);
  }

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    const { personaId, credsPath } = await this.enroll(req.personaName);

    const command = [
      'env',
      `PORTAL_PERSONA_NAME=${shq(req.personaName)}`,
      `PORTAL_SUBSCRIPTIONS=${shq(req.channelId)}`,
      `PORTAL_CONTEXT_CAP=${shq(String(this.config.contextCap))}`,
      'claude',
      '--dangerously-skip-permissions',
      '--dangerously-load-development-channels server:portal',
      // Resume reuses the id (no --fork-session), so one persona keeps ONE
      // durable transcript across any number of revivals.
      req.resume ? `--resume ${shq(req.sessionId)}` : `--session-id ${shq(req.sessionId)}`,
      `--model ${shq(req.model)}`,
      `"$(cat ${shq(req.seedFile)})"`,
    ].join(' ');

    await newSession(req.tmuxSession, this.config.projectDir, command);
    const warning = await this.dismissDevChannelsPrompt(req.tmuxSession);
    return { personaId, credsPath, warning };
  }

  /**
   * Watch the pane for the dev-channels confirmation and press Enter for it.
   * Harmless if the prompt never appears (future CC versions may drop it).
   */
  private async dismissDevChannelsPrompt(session: string): Promise<string | undefined> {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    let sends = 0;
    let seen = false;
    while (Date.now() < deadline) {
      if (!(await hasSession(session))) {
        throw new Error('claude exited during startup — check model name and `claude` CLI health');
      }
      // Don't swallow capture errors silently — a broken target spec here once
      // masked the whole handshake (the prompt sat undismissed for 90s).
      const pane = await capturePane(session).catch((err) => {
        console.warn(`[launcher] capture-pane ${session} failed: ${(err as Error).message.split('\n').join(' | ')}`);
        return '';
      });
      if (DEV_CHANNELS_PROMPT_RE.test(pane)) {
        seen = true;
        if (sends >= MAX_ENTER_SENDS) {
          return `dev-channels prompt did not dismiss after ${MAX_ENTER_SENDS} attempts — run: tmux attach -t ${session}`;
        }
        await sendKeys(session, 'Enter');
        sends++;
      } else if (seen) {
        return undefined; // prompt appeared and is gone — dismissed
      }
      await sleep(HANDSHAKE_POLL_MS);
    }
    return seen
      ? `dev-channels prompt may still be blocking — run: tmux attach -t ${session}`
      : undefined; // never appeared within the window; assume this CC has no prompt
  }
}

// ── Codex ──

const CODEX_STARTUP_TIMEOUT_MS = 60_000;
const CODEX_POLL_MS = 2_000;
/** Interactive gates codex may raise before taking the prompt (all seen live). */
const CODEX_MODEL_DEPRECATED_RE = /Use existing model/;
const CODEX_PRESS_ENTER_RE = /Press enter to continue/i;
// The header box scrolls off fast once codex starts working, so also accept
// the idle composer / status line as "up" (seen live: the header had already
// scrolled away by the first poll that found no gate).
const CODEX_READY_RE = /permissions: YOLO mode|Ask Codex to do anything|^\s*›\s/m;
const CODEX_LOGIN_RE = /Sign in with ChatGPT|codex login/i;
const SESSION_DISCOVERY_MS = 45_000;

/** TOML basic string — JSON string escaping is a valid subset. */
const toml = (s: string): string => JSON.stringify(s);

export class CodexLauncher implements Launcher {
  readonly engine = 'codex';

  constructor(private readonly config: SpawnerConfig) {}

  async enroll(personaName: string, invite?: string): Promise<{ personaId: string; credsPath: string }> {
    return enrollPersona(this.config, personaName, invite);
  }

  async launch(req: LaunchRequest): Promise<LaunchResult> {
    const { personaId, credsPath } = await this.enroll(req.personaName);

    // Portal as a plain MCP server, scoped to this launch via -c overrides (no
    // edit to ~/.codex/config.toml). Creds are pre-enrolled, so no invite is
    // handed to the hand. Codex does not pass its own env to MCP children —
    // everything the server needs goes in mcp_servers.portal.env (HOME included:
    // `codex queue` has to find ~/.codex from inside that child).
    const wakeFile = join(PORTAL_DIR, `${personaId}.wake.json`);
    const env =
      `{PORTAL_URL=${toml(this.config.url)},PORTAL_PERSONA_NAME=${toml(req.personaName)},` +
      `PORTAL_SUBSCRIPTIONS=${toml(req.channelId)},PORTAL_CONTEXT_CAP=${toml(String(this.config.contextCap))},` +
      `PORTAL_WAKE="codex",PORTAL_WAKE_FILE=${toml(wakeFile)},HOME=${toml(homedir())}}`;
    const opts = [
      '--dangerously-bypass-approvals-and-sandbox', // = --yolo
      `-m ${shq(req.model)}`,
      `-c ${shq('mcp_servers.portal.command="node"')}`,
      `-c ${shq(`mcp_servers.portal.args=[${toml(this.config.ccCli)}]`)}`,
      `-c ${shq(`mcp_servers.portal.env=${env}`)}`,
    ];
    const prompt = `"$(cat ${shq(req.seedFile)})"`;
    const command = req.resume
      ? [this.config.codexBin, 'resume', ...opts, shq(req.sessionId), prompt].join(' ')
      : [this.config.codexBin, ...opts, prompt].join(' ');

    const startedAt = Date.now();
    await newSession(req.tmuxSession, this.config.projectDir, command);
    const warnings: string[] = [];
    const startup = await this.settleStartup(req.tmuxSession);
    if (startup) warnings.push(startup);
    const sessionId = req.resume ? req.sessionId : await this.discoverSessionId(startedAt);
    if (!sessionId) {
      warnings.push('could not find its codex session id — mention-wake is off and a revival would start fresh');
      return { personaId, credsPath, sessionId, warning: warnings.join('; ') };
    }
    // The wake sidecar: the hand's portal server reads it on every mention.
    const codexBin = resolveOnPath(this.config.codexBin);
    if (codexBin === this.config.codexBin && !codexBin.includes('/')) {
      warnings.push(`could not resolve \`${codexBin}\` to a path — its portal server may fail to wake it`);
    }
    let wake: 'cc-cli' | undefined;
    try {
      mkdirSync(PORTAL_DIR, { recursive: true });
      writeFileSync(
        wakeFile,
        JSON.stringify({ codexBin, threadId: sessionId, tmuxSession: req.tmuxSession, updatedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      wake = 'cc-cli';
    } catch (err) {
      warnings.push(`could not write its wake sidecar (${(err as Error).message}) — falling back to home-channel wake`);
    }
    return { personaId, credsPath, sessionId, wake, warning: warnings.length ? warnings.join('; ') : undefined };
  }

  /** Press through codex's startup gates (directory trust, model-deprecation
   *  notice) until the session header is up. */
  private async settleStartup(session: string): Promise<string | undefined> {
    const deadline = Date.now() + CODEX_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await hasSession(session))) {
        throw new Error('codex exited during startup — check model name and `codex` CLI health');
      }
      const pane = await capturePane(session).catch((err) => {
        console.warn(`[launcher] capture-pane ${session} failed: ${(err as Error).message.split('\n').join(' | ')}`);
        return '';
      });
      if (CODEX_LOGIN_RE.test(pane)) return `codex wants a login — run: tmux attach -t ${session}`;
      if (CODEX_MODEL_DEPRECATED_RE.test(pane)) {
        // "Try new model / Use existing model" — keep the model that was asked for.
        await sendKeys(session, 'Down');
        await sleep(300);
        await sendKeys(session, 'Enter');
      } else if (CODEX_PRESS_ENTER_RE.test(pane)) {
        await sendKeys(session, 'Enter');
      } else if (CODEX_READY_RE.test(pane)) {
        return undefined;
      }
      await sleep(CODEX_POLL_MS);
    }
    return `codex did not reach its prompt within ${CODEX_STARTUP_TIMEOUT_MS / 1000}s — run: tmux attach -t ${session}`;
  }

  /** Codex names each conversation's rollout file after its own UUID:
   *  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, first line
   *  `session_meta` with the cwd. Spawns are serialized, so the newest rollout
   *  for our cwd written since launch is ours. */
  private async discoverSessionId(startedAt: number): Promise<string | undefined> {
    const root = join(homedir(), '.codex', 'sessions');
    const cwd = safeRealpath(this.config.projectDir);
    const deadline = Date.now() + SESSION_DISCOVERY_MS;
    while (Date.now() < deadline) {
      const found = latestRollout(root, startedAt - 5_000, cwd);
      if (found) return found;
      await sleep(CODEX_POLL_MS);
    }
    return undefined;
  }
}

/** A bare binary name → absolute path via PATH (the MCP child that runs it
 *  gets no PATH from codex). Paths pass through; unresolvable names return
 *  unchanged so the caller can warn. */
export function resolveOnPath(bin: string, path = process.env.PATH ?? ''): string {
  if (bin.includes('/')) return bin;
  for (const dir of path.split(':').filter(Boolean)) {
    const candidate = join(dir, bin);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return bin;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Newest rollout under root (today/yesterday, UTC) modified after `since`
 *  whose session_meta cwd matches. Returns the uuid from the filename. */
export function latestRollout(root: string, since: number, cwd: string): string | undefined {
  const days: string[] = [];
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 86_400_000);
    days.push(join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')));
  }
  let best: { id: string; mtime: number } | undefined;
  for (const dir of days) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
      if (!m) continue;
      const path = join(dir, name);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < since || (best && mtime <= best.mtime)) continue;
      try {
        const first = readFileSync(path, 'utf8').split('\n', 1)[0];
        const meta = JSON.parse(first) as { type?: string; payload?: { cwd?: string } };
        if (meta.type !== 'session_meta' || safeRealpath(meta.payload?.cwd ?? '') !== cwd) continue;
      } catch {
        continue;
      }
      best = { id: m[1], mtime };
    }
  }
  return best?.id;
}
