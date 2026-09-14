/**
 * Thin async wrappers around the tmux CLI. All session interaction goes through
 * here so launcher/reaper stay shell-free.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function hasSession(name: string): Promise<boolean> {
  try {
    await run('tmux', ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** Create a detached session running `command` (via sh -c) in `cwd`. */
export async function newSession(name: string, cwd: string, command: string): Promise<void> {
  await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, command]);
}

export async function killSession(name: string): Promise<void> {
  try {
    await run('tmux', ['kill-session', '-t', `=${name}`]);
  } catch {
    /* already gone */
  }
}

// NB: pane-target contexts (capture-pane, send-keys) need `=name:` — the bare
// `=name` exact-match form only parses in session-target contexts (has-session,
// kill-session). Verified on tmux 3.6a; `=name` there fails with
// "can't find pane".
export async function capturePane(name: string, scrollbackLines = 0): Promise<string> {
  const args = ['capture-pane', '-p'];
  if (scrollbackLines > 0) args.push('-S', `-${scrollbackLines}`);
  args.push('-t', `=${name}:`);
  const { stdout } = await run('tmux', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Seconds since the session was created (tmux #{session_created} is epoch s). */
export async function sessionUptime(name: string): Promise<number | undefined> {
  try {
    const { stdout } = await run('tmux', ['display', '-p', '-t', `=${name}:`, '#{session_created}']);
    const created = Number(stdout.trim());
    return Number.isFinite(created) ? Math.max(0, Math.floor(Date.now() / 1000 - created)) : undefined;
  } catch {
    return undefined;
  }
}

export async function sendKeys(name: string, ...keys: string[]): Promise<void> {
  await run('tmux', ['send-keys', '-t', `=${name}:`, ...keys]);
}

/** Send literal text (no key-name interpretation — `-l`). */
export async function sendText(name: string, text: string): Promise<void> {
  await run('tmux', ['send-keys', '-t', `=${name}:`, '-l', text]);
}

export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').filter(Boolean);
  } catch {
    return []; // no tmux server running ⇒ no sessions
  }
}
