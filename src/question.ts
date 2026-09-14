/**
 * Multiple-choice bridge — when a spawned bot's session raises an
 * AskUserQuestion dialog, the session BLOCKS on an interactive TUI nobody is
 * watching. This module turns that dialog into a channel post and turns channel
 * answers back into keystrokes.
 *
 * DETECTION IS PANE-BASED, NOT TRANSCRIPT-BASED — verified live 2026-08-24:
 * while a dialog is open the transcript contains NO trace of it; the assistant
 * tool_use and its tool_result are written together only when the dialog
 * resolves. So: the tmux pane tells us a question is pending (and what it is);
 * the transcript pair arriving later is the ground-truth confirmation.
 *
 * TUI mechanics (verified live against claude 2.1.241):
 *  - single-select: pressing the option digit selects AND submits immediately
 *  - multiSelect: digits toggle [✔]; Tab advances
 *  - multi-question: one question on screen at a time (tab bar
 *    `←  ☐ A  ☐ B  ✔ Submit  →`); after the last, a "Review your answers …
 *    1. Submit answers" screen appears — we bridge these dialogs one screen at
 *    a time and auto-confirm the review
 *  - free text: a numbered "Type something." entry — digit, type, Enter
 *  - Esc cancels the whole dialog (tool_result becomes a rejection)
 * Every dialog screen carries the "Chat about this" footer entry — the marker.
 *
 * PERMISSION PROMPTS are bridged the same way (verified live 2026-09-01,
 * claude 2.1.258): even under --dangerously-skip-permissions, Claude Code still
 * stops on a few safety checks ("Dangerous rm operation on possibly-empty
 * variable path: …") with a `Do you want to proceed? ❯ 1. Yes / 2. No` dialog
 * and an "Esc to cancel · Tab to amend" footer. Like AskUserQuestion it leaves
 * no transcript trace while open; the tool_use + tool_result pair lands on
 * resolution (a "No" yields an is_error tool_result "The user doesn't want to
 * proceed with this tool use…"). Digits select AND submit. Resolution is
 * observed pane-side (the dialog disappears).
 */
import { capturePane, sendKeys, sendText } from './tmux.js';
import type { BotEntry } from './registry.js';

/** The currently displayed question of a dialog, parsed from the pane. */
export interface PendingQ {
  /** AskUserQuestion (default) or a tool permission prompt. */
  kind?: 'question' | 'permission';
  /** Permission prompts: the dialog title ("Bash command", "Edit file", …). */
  title?: string;
  /** Permission prompts: the command/diff box + any warning line. */
  detail?: string;
  question: string;
  multiSelect: boolean;
  options: { label: string }[];
  /** The dialog number of the "Type something." entry (free-text answers). */
  textOptionIndex?: number;
}

export interface PendingQuestion {
  /** Stable signature of the displayed question — a changed sig means the
   *  dialog advanced to its next part (repost). */
  sig: string;
  /** Relay id of the channel post presenting the dialog — the reply target. */
  messageId?: string;
  postedAt: string;
  /** The question currently on screen (dialogs are bridged screen by screen). */
  questions: PendingQ[];
  /** Tab-bar headers when the dialog has several parts (e.g. Scope, Size). */
  parts?: string[];
  /** What was sent from the channel (`answer`/`press`) — used to word the
   *  resolution notice for permission prompts, which resolve pane-side. */
  answeredWith?: string;
}

export type PaneDialog =
  | { kind: 'none' }
  | { kind: 'review' }
  | { kind: 'question'; q: PendingQ; parts?: string[] };

const FOOTER_RE = /^\s*\d+\.\s+Chat about this/;
const OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const CHECKBOX_RE = /^\[[ ✔x]\]\s*/i;
const TYPE_SOMETHING_RE = /^type something\.?$/i;
const REVIEW_RE = /Ready to submit your answers\?/;
const TAB_BAR_RE = /[☐☒]/;
const PERM_QUESTION_RE = /^\s*Do you want to [^?]*\?\s*$/;
const PERM_FOOTER_RE = /Esc to cancel/;
const SEPARATOR_RE = /^[─━-]{6,}\s*$/;
const BOX_PREFIX_RE = /^\s*│\s?/;

/** Parse a captured tmux pane for an open tool-permission prompt. Shape:
 *  separator · title line · boxed command/diff · description · optional
 *  warning · "Do you want to proceed?" · numbered options · "Esc to cancel". */
function parsePermissionPane(lines: string[]): PaneDialog {
  const qIdx = lines.findIndex((l) => PERM_QUESTION_RE.test(l));
  if (qIdx === -1) return { kind: 'none' };
  const options: { label: string }[] = [];
  let sawFooter = false;
  for (let i = qIdx + 1; i < lines.length; i++) {
    if (PERM_FOOTER_RE.test(lines[i])) {
      sawFooter = true;
      break;
    }
    const m = lines[i].match(OPTION_RE);
    if (m) options.push({ label: m[2].trim() });
  }
  if (!sawFooter || options.length === 0) return { kind: 'none' };
  let sepIdx = -1;
  for (let j = qIdx - 1; j >= 0; j--) {
    if (SEPARATOR_RE.test(lines[j].trim())) {
      sepIdx = j;
      break;
    }
  }
  const block = lines.slice(sepIdx + 1, qIdx).filter((l) => l.trim());
  const title = block[0]?.trim() || 'Permission request';
  const detail = block
    .slice(1)
    .map((l) => (BOX_PREFIX_RE.test(l) ? l.replace(BOX_PREFIX_RE, '') : l.trim()))
    .join('\n')
    .trim();
  return {
    kind: 'question',
    q: { kind: 'permission', title, detail, question: lines[qIdx].trim(), multiSelect: false, options },
  };
}

/** Parse a captured tmux pane for an open AskUserQuestion dialog or a tool
 *  permission prompt (both block the session; both are bridged). */
export function parseDialogPane(pane: string): PaneDialog {
  if (REVIEW_RE.test(pane)) return { kind: 'review' };
  const lines = pane.split('\n');
  const footerIdx = lines.findIndex((l) => FOOTER_RE.test(l));
  if (footerIdx === -1) return parsePermissionPane(lines);

  // Tab bar (multi-part) or single-part header line ("☐ Fruit") above the body.
  let headerIdx = -1;
  let parts: string[] | undefined;
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (TAB_BAR_RE.test(lines[i])) {
      headerIdx = i;
      if (lines[i].includes('Submit')) {
        parts = [...lines[i].matchAll(/[☐☒]\s+([^☐☒✔←→]+?)(?=\s{2,}|$)/g)].map((m) => m[1].trim());
      }
      break;
    }
  }

  const body = lines.slice(headerIdx + 1, footerIdx);
  const options: { label: string }[] = [];
  let textOptionIndex: number | undefined;
  let multiSelect = false;
  const questionLines: string[] = [];
  let sawOption = false;
  for (const line of body) {
    if (/^[─━-]{6,}\s*$/.test(line.trim())) continue;
    const m = line.match(OPTION_RE);
    if (m) {
      sawOption = true;
      let label = m[2];
      if (CHECKBOX_RE.test(label)) {
        multiSelect = true;
        label = label.replace(CHECKBOX_RE, '');
      }
      if (TYPE_SOMETHING_RE.test(label.trim())) {
        textOptionIndex = parseInt(m[1], 10);
      } else {
        options.push({ label: label.trim() });
      }
    } else if (!sawOption && line.trim()) {
      questionLines.push(line.trim());
    }
    // Indented description lines under options are ignored — labels suffice.
  }
  if (!sawOption || options.length === 0) return { kind: 'none' };
  return {
    kind: 'question',
    q: { question: questionLines.join(' ').trim(), multiSelect, options, textOptionIndex },
    parts,
  };
}

/** Signature of a displayed question, to notice the dialog advancing. */
export function dialogSig(q: PendingQ): string {
  return [q.kind ?? 'question', q.title ?? '', q.detail ?? '', q.question, ...q.options.map((o) => o.label)].join('§');
}

const DISCORD_BUDGET = 1900;

/** Render the dialog as a channel post. Explicit about the one thing observers
 *  get wrong: the bot cannot read the channel right now — talking to it in
 *  natural language goes nowhere; answers must go through cc-spawner. */
export function formatQuestionPost(entry: BotEntry, pending: PendingQuestion): string {
  const q = pending.questions[0];
  if (q.kind === 'permission') return formatPermissionPost(entry, q);
  const partsNote =
    pending.parts && pending.parts.length > 1
      ? `\n*(part of a ${pending.parts.length}-question dialog — ${pending.parts.join(', ')} — I'll post each part as it comes up)*`
      : '';
  const parts: string[] = [
    `❓ **${entry.personaName}** is asking a multiple-choice question — its session is **blocked on a dialog and cannot see this channel**. 🤖 Answering in natural language will NOT work (that includes other models): answers must go through me, via @-mention:`,
    `\`@cc-spawner answer ${entry.suffix} <choice>\` — a number (\`2\`)${q.multiSelect ? ', several (`1,3`)' : ''}, custom text (\`text: …\`), or \`esc\` to dismiss. Humans may also just reply to this message with the choice.`,
    `**${q.question}**${q.multiSelect ? ' *(pick any)*' : ''}${partsNote}`,
  ];
  for (const [i, opt] of q.options.entries()) parts.push(`> ${i + 1}. **${opt.label}**`);
  const post = parts.join('\n');
  return post.length > DISCORD_BUDGET ? post.slice(0, DISCORD_BUDGET - 1) + '…' : post;
}

const DETAIL_BUDGET = 1100;

/** A tool permission prompt: show the exact command/diff so the approver can
 *  judge it, and make the two keystrokes obvious. */
function formatPermissionPost(entry: BotEntry, q: PendingQ): string {
  const detail = q.detail ?? '';
  const shown = detail.length > DETAIL_BUDGET ? detail.slice(0, DETAIL_BUDGET - 1) + '…' : detail;
  const parts: string[] = [
    `🔐 **${entry.personaName}** is waiting on a permission prompt — its session is **blocked on a dialog and cannot see this channel**. 🤖 Natural-language replies will NOT reach it (other models included): answer through me via @-mention:`,
    `\`@cc-spawner answer ${entry.suffix} 1\` to approve, \`… 2\` to deny (\`yes\`/\`no\` and \`esc\` work too). Humans may also just reply to this message with the number.`,
    `**${q.title ?? 'Permission request'}**`,
  ];
  if (shown) parts.push('```\n' + shown.replace(/```/g, "'''") + '\n```');
  parts.push(`**${q.question}**`);
  for (const [i, opt] of q.options.entries()) parts.push(`> ${i + 1}. **${opt.label}**`);
  const post = parts.join('\n');
  return post.length > DISCORD_BUDGET ? post.slice(0, DISCORD_BUDGET - 1) + '…' : post;
}

// ── Answer parsing ──

export type ParsedAnswer =
  | { kind: 'esc' }
  | { kind: 'digits'; nums: number[] }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string };

const DIGITS_RE = /^\d+(\s*,\s*\d+)*$/;

/** Parse an answer spec against the displayed question. */
export function parseAnswerSpec(body: string, q: PendingQ): ParsedAnswer {
  const spec = body.trim();
  if (!spec) return { kind: 'error', error: 'empty answer' };
  if (/^(esc|escape|dismiss|cancel)$/i.test(spec)) return { kind: 'esc' };
  const textMatch = spec.match(/^text:\s*(.*)$/is);
  if (textMatch) {
    const text = textMatch[1].trim();
    return text ? { kind: 'text', text } : { kind: 'error', error: 'empty custom text' };
  }
  if (DIGITS_RE.test(spec)) {
    const nums = [...new Set(spec.split(',').map((n) => parseInt(n.trim(), 10)))];
    const bad = nums.find((n) => n < 1 || n > q.options.length);
    if (bad !== undefined) {
      return { kind: 'error', error: `option ${bad} is out of range (1-${q.options.length})` };
    }
    if (!q.multiSelect && nums.length !== 1) {
      return { kind: 'error', error: 'this question is single-choice — give exactly one number' };
    }
    return { kind: 'digits', nums };
  }
  // A bare word that names an option (exactly, or as a unique prefix —
  // `yes` → "Yes", `no` → "No") selects it; permission prompts have no
  // free-text entry so this is the only non-numeric form that works there.
  const lc = spec.toLowerCase();
  const exact = q.options.findIndex((o) => o.label.toLowerCase() === lc);
  if (exact !== -1) return { kind: 'digits', nums: [exact + 1] };
  const synonyms: Record<string, string> = { y: 'yes', ok: 'yes', allow: 'yes', approve: 'yes', proceed: 'yes', n: 'no', deny: 'no', reject: 'no' };
  const needle = synonyms[lc] ?? lc;
  const prefixed = q.options.map((o, i) => ({ o, i })).filter(({ o }) => o.label.toLowerCase().startsWith(needle));
  if (prefixed.length === 1 && /^[a-z]/.test(needle)) return { kind: 'digits', nums: [prefixed[0].i + 1] };
  if (q.kind === 'permission') {
    return { kind: 'error', error: `pick an option by number (1-${q.options.length}), \`yes\`/\`no\`, or \`esc\`` };
  }
  // Bare non-numeric answer = custom text.
  return { kind: 'text', text: spec };
}

// ── Injection ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY_SETTLE_MS = 350;

/**
 * Drive the currently displayed question in the bot's tmux pane. Throws with an
 * operator-readable message if the expected dialog isn't on screen. The
 * transcript watcher provides the ground-truth confirmation (the tool_use +
 * tool_result pair lands when the whole dialog resolves) — this only pushes
 * keys.
 */
export async function injectAnswer(
  tmuxSession: string,
  expected: PendingQuestion,
  parsed: ParsedAnswer,
): Promise<string | undefined> {
  const dialog = parseDialogPane(await capturePane(tmuxSession));
  if (dialog.kind === 'none') {
    throw new Error(
      'no question dialog is on screen (already answered in the terminal, or the session moved on) — `rescan` to refresh',
    );
  }
  if (dialog.kind === 'review') {
    throw new Error('the dialog is on its final review screen — `rescan` to refresh, or answer `1` after it reposts');
  }
  if (dialogSig(dialog.q) !== expected.sig) {
    throw new Error('the dialog moved on to a different question — `rescan` to repost the current one');
  }
  const q = dialog.q;

  if (parsed.kind === 'esc') {
    await sendKeys(tmuxSession, 'Escape');
    return undefined;
  }
  if (parsed.kind === 'digits') {
    for (const n of parsed.nums) {
      await sendKeys(tmuxSession, String(n));
      await sleep(KEY_SETTLE_MS);
    }
    // multiSelect digits only toggle — advance explicitly. Single-select
    // auto-advances (and auto-submits when it's the only question).
    if (q.multiSelect) await sendKeys(tmuxSession, 'Tab');
  } else if (parsed.kind === 'text') {
    if (q.textOptionIndex === undefined) throw new Error('this dialog has no free-text entry — pick a number');
    await sendKeys(tmuxSession, String(q.textOptionIndex));
    await sleep(KEY_SETTLE_MS);
    await sendText(tmuxSession, parsed.text);
    await sleep(KEY_SETTLE_MS);
    await sendKeys(tmuxSession, 'Enter');
  } else {
    throw new Error('unparsed answer'); // guarded by caller
  }

  // Single-question dialogs are done; multi-part ones either show the next
  // question (the watcher reposts it) or the review screen — confirm that.
  await sleep(700);
  const after = parseDialogPane(await capturePane(tmuxSession));
  if (after.kind === 'review') {
    await sendKeys(tmuxSession, '1');
    return undefined;
  }
  if (after.kind === 'question' && dialogSig(after.q) === expected.sig) {
    return `the dialog is still showing the same question after my keystrokes — check \`peek\` or tmux attach -t ${tmuxSession}`;
  }
  if (after.kind === 'question') {
    return 'that part is answered — the dialog moved to its next question, posting it here shortly.';
  }
  return undefined;
}
