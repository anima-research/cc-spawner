/**
 * Command parsing/validation shared by both control surfaces.
 *
 * Text grammar (portal @-mentions, over cleanContent with leading mention
 * tokens stripped):
 *   spawn <model> [name=<friendly>] [engine=claude]
 *   list
 *   stop <name>        (alias: kill)
 *   help
 *
 * The Discord slash surface skips parsing (Discord structures the options) and
 * uses buildSpawnCommand/buildStopCommand for the same validation.
 */
export type Command =
  | { kind: 'spawn'; model: string; friendly?: string; engine: Engine }
  | { kind: 'list' }
  | { kind: 'stop'; target: string }
  | { kind: 'peek'; target: string; lines?: number }
  | { kind: 'answer'; target: string; spec: string }
  | { kind: 'press'; target: string; keys: string[] }
  | { kind: 'rescan' }
  | { kind: 'help'; error?: string };

// Model ids may be aliases (opus), dotted ids (claude-opus-4.5), or provider
// paths (bedrock ids with : and /). Always single-quoted into the shell later.
const MODEL_RE = /^[A-Za-z0-9._:@/-]+$/;

export type Engine = 'claude' | 'codex';
export const ENGINES: readonly Engine[] = ['claude', 'codex'];
/** Codex model suggestions (gpt-6-astra needs codex CLI ≥ 0.153; the rest from
 *  ~/.codex/models_cache.json, 2026-09-04). */
export const CODEX_MODEL_CHOICES = ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.3-codex-spark'];
const CODEX_MODEL_RE = /^(gpt-|o\d|codex)/i;

/** Engine implied by the model name when none is given explicitly. */
export function inferEngine(model: string): Engine {
  return CODEX_MODEL_RE.test(model) ? 'codex' : 'claude';
}
const FRIENDLY_RE = /^[A-Za-z0-9-]{1,24}$/;

export const USAGE = [
  'Usage:',
  '`spawn <model> [name=<friendly>] [engine=claude|codex]` — spawn a bot here (model required, explicit: fable-5-1, fable-5, opus-5, sonnet-5, haiku-4-5, … or a full id; gpt-* models run on codex)',
  '`list` — show running bots',
  '`stop <name>` — stop a bot (by friendly name, suffix, or persona name; identity is kept)',
  '`peek <name> [lines]` — DM yourself the bot\'s terminal tail (default 20 lines; slash surface only)',
  '`answer <name> <choice>` — answer a bot\'s pending question or permission prompt (`2`, `1,3`, `yes`/`no`, `text: …`, or `esc`)',
  '`press <name> <keys…>` — raw keystrokes into a bot\'s terminal to unstick it (`press scout 1 enter`; keys: digits, `enter`, `esc`, `tab`, `up`/`down`, `ctrl-c`, or literal text)',
  '`rescan` — re-check all running bots for an unanswered question dialog and (re)post it here',
].join('\n');

/** Validate + build an answer command (shared by text and slash surfaces). */
export function buildAnswerCommand(target: string | undefined, spec: string | undefined): Command {
  if (!target) return { kind: 'help', error: 'answer needs a target — `answer <name> <choice>`' };
  if (!spec || !spec.trim()) {
    return { kind: 'help', error: 'answer needs a choice — a number (`2`), `1,3`, `text: …`, or `esc`' };
  }
  return { kind: 'answer', target, spec: spec.trim() };
}

/**
 * Short, name-safe token for a model id, for use in persona names:
 *   fable → fable · claude-fable-5 → fable-5 · claude-opus-4-8 → opus-4-8
 *   global.anthropic.claude-sonnet-4-5 → sonnet-4-5
 * Kept short because the relay slugs personaIds to 32 chars before adding its
 * own -6hex uniqueness suffix.
 */
export function modelSlug(model: string): string {
  let s = model.toLowerCase();
  s = s.split('/').pop() ?? s; // provider paths
  s = s.split(':').pop() ?? s; // bedrock-style ids
  s = s.replace(/^.*\banthropic\./, ''); // us.anthropic. / global.anthropic.
  s = s.replace(/^claude-?/, '');
  s = s.replace(/-\d{8}$/, ''); // dated snapshot suffix (…-20250805)
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 12).replace(/-+$/, '') || 'model';
}

const PRESS_MAX_KEYS = 20;

export function buildPressCommand(target: string | undefined, keys: string | undefined): Command {
  if (!target) return { kind: 'help', error: 'press needs a target — `press <name> <keys…>`' };
  const list = (keys ?? '').trim().split(/\s+/).filter(Boolean);
  if (list.length === 0) return { kind: 'help', error: 'press needs keys — e.g. `press scout 1 enter` or `press scout esc`' };
  if (list.length > PRESS_MAX_KEYS) return { kind: 'help', error: `at most ${PRESS_MAX_KEYS} keys per press` };
  return { kind: 'press', target, keys: list };
}

/**
 * Explicit model names → ids passed to `claude --model`. Bare family aliases
 * (`fable`, `opus`, `sonnet`, `haiku`) are deliberately NOT accepted: the CLI
 * silently re-points them on upgrade (`fable` became claude-fable-5-1 in
 * 2.1.25x), and the model token is part of the persona name — a name must
 * keep meaning one model. Full ids (`claude-…`) pass through untouched.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'fable-5-1': 'claude-fable-5-1',
  'fable-5': 'claude-fable-5',
  'opus-5': 'claude-opus-5',
  'opus-4-8': 'claude-opus-4-8',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'haiku-4-5': 'claude-haiku-4-5',
};
/** Suggestion order for autocomplete/docs. */
export const MODEL_CHOICES = Object.keys(MODEL_ALIASES);

const BARE_FAMILY_RE = /^(fable|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** `fable5.1` / `Fable-5.1` / `fable51` → `fable-5-1`. */
function normalizeAlias(model: string): string {
  const m = model.toLowerCase().match(/^([a-z]+)[-.]?(\d)(?:[-.]?(\d))?$/);
  if (m && FAMILIES.includes(m[1])) return `${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
  return model.toLowerCase();
}

export function resolveModel(model: string): string {
  return MODEL_ALIASES[normalizeAlias(model)] ?? model;
}

/** Bare family alias? (retired — see MODEL_ALIASES) */
export function isBareFamilyAlias(model: string): boolean {
  return BARE_FAMILY_RE.test(model);
}

/** Validate + build a spawn command (shared by text and slash surfaces). */
export function buildSpawnCommand(model: string | undefined, friendly?: string, engine?: string): Command {
  if (friendly !== undefined && !FRIENDLY_RE.test(friendly)) {
    return { kind: 'help', error: `bad name \`${friendly}\` — use 1-24 chars of [A-Za-z0-9-]` };
  }
  if (!model) return { kind: 'help', error: 'model is required — e.g. `spawn fable-5-1`, `spawn opus-5`, `spawn sonnet-5 name=scout`, or `spawn gpt-5.6-luna` (codex)' };
  if (!MODEL_RE.test(model)) return { kind: 'help', error: `bad model \`${model}\`` };
  if (engine !== undefined && !ENGINES.includes(engine as Engine)) {
    return { kind: 'help', error: `engine \`${engine}\` not supported — ${ENGINES.map((e) => `\`${e}\``).join(' or ')}` };
  }
  const eng: Engine = (engine as Engine | undefined) ?? inferEngine(model);
  if (eng === 'codex') return { kind: 'spawn', model, friendly, engine: 'codex' };
  if (isBareFamilyAlias(model)) {
    return {
      kind: 'help',
      error: `bare \`${model}\` is retired — say which version: ${MODEL_CHOICES.map((c) => `\`${c}\``).join(', ')}, or a full id like \`claude-fable-5-1\``,
    };
  }
  return { kind: 'spawn', model: resolveModel(model), friendly, engine: 'claude' };
}

export function buildStopCommand(target: string | undefined): Command {
  if (!target) return { kind: 'help', error: 'stop needs a target — `stop <name>`' };
  return { kind: 'stop', target };
}

export const PEEK_DEFAULT_LINES = 20;
export const PEEK_MAX_LINES = 400;

export function buildPeekCommand(target: string | undefined, lines?: number | string): Command {
  if (!target) return { kind: 'help', error: 'peek needs a target — `peek <name>`' };
  if (lines === undefined || lines === '') return { kind: 'peek', target };
  const n = typeof lines === 'number' ? lines : Number(lines);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > PEEK_MAX_LINES) {
    return { kind: 'help', error: `lines must be a whole number from 1 to ${PEEK_MAX_LINES}` };
  }
  return { kind: 'peek', target, lines: n };
}

/** Strip leading mention tokens (@cc-spawner …) and normalize whitespace. */
function stripMentions(cleanContent: string): string {
  const tokens = cleanContent.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('@')) i++;
  return tokens.slice(i).join(' ');
}

export function parseCommand(cleanContent: string): Command {
  const body = stripMentions(cleanContent);
  const tokens = body.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'help' };
  const verb = tokens[0].toLowerCase();

  switch (verb) {
    case 'spawn': {
      let model: string | undefined;
      let friendly: string | undefined;
      let engine: string | undefined;
      for (const tok of tokens.slice(1)) {
        const kv = tok.match(/^([a-z]+)=(.*)$/);
        if (kv) {
          const [, key, value] = kv;
          if (key === 'name') {
            friendly = value;
          } else if (key === 'engine') {
            engine = value.toLowerCase();
          } else if (key === 'model') {
            model = value;
          } else {
            return { kind: 'help', error: `unknown option \`${key}=\`` };
          }
        } else if (!model) {
          model = tok;
        } else {
          return { kind: 'help', error: `unexpected token \`${tok}\`` };
        }
      }
      return buildSpawnCommand(model, friendly, engine);
    }
    case 'list':
      return { kind: 'list' };
    case 'stop':
    case 'kill': // legacy alias
      return buildStopCommand(tokens[1]);
    case 'peek':
      return buildPeekCommand(tokens[1], tokens[2]);
    case 'answer': {
      // The spec is free text (may contain spaces, `text: …`) — take the raw
      // remainder after the target token, not the whitespace-normalized tokens.
      const afterVerb = body.slice(body.toLowerCase().indexOf('answer') + 'answer'.length).trim();
      const target = afterVerb.split(/\s+/)[0];
      const spec = afterVerb.slice(target?.length ?? 0).trim();
      return buildAnswerCommand(target || undefined, spec || undefined);
    }
    case 'press':
    case 'keys':
      return buildPressCommand(tokens[1], tokens.slice(2).join(' '));
    case 'rescan':
    case 'scan':
      return { kind: 'rescan' };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'help', error: `unknown command \`${verb}\`` };
  }
}
