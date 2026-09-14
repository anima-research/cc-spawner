/**
 * Authorization, transport-neutral.
 *
 * `isAllowed` is a pure sync check over an Invoker whose roles arrive however
 * the transport gets them:
 *  - Discord slash: roles + ManageGuild bit come INLINE on the interaction
 *    payload (free, no intent needed).
 *  - Portal mentions: the transport pre-fetches roles via PortalRoleFetcher
 *    (list_members RPC + 60s cache); fetch failure ⇒ roles undefined ⇒ only
 *    the allowedUsers leg can pass.
 *
 * Fail closed on every uncertain path: no guild, unknown roles, empty
 * allow-lists.
 */
import type { PortalClient } from '@animalabs/portal-client';

export interface Invoker {
  /** Discord user id — or, for kind 'resident', a portal persona id OR a
   *  resident bot account's Discord user id. */
  id: string;
  /** Username / persona display name (for audit strings). */
  name: string;
  /** 'user' (default) or 'resident' — fleet agents driving the spawner. */
  kind?: 'user' | 'resident';
  /** Role ids held in the guild; undefined = unknown (portal fetch failed). */
  roles?: string[];
  /** Live Manage-Server permission, when the transport can evaluate it. */
  hasManageGuild?: boolean;
}

export interface AuthConfig {
  allowedUsers: string[];
  allowedRoles: Record<string, string[]>;
  /** Resident ids allowed to drive the spawner — portal persona ids AND/OR
   *  discord-integration bot user ids (distinct id spaces, one list). */
  allowedResidents: string[];
  /** Treat Discord Manage-Server as authorized (relay slash semantics). */
  allowManageGuild: boolean;
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

export function isAllowed(invoker: Invoker, guildId: string | null, cfg: AuthConfig): AuthResult {
  if (!guildId) {
    return { ok: false, reason: 'spawner commands only work in a guild channel (no DMs)' };
  }
  if (invoker.kind === 'resident') {
    // Residents get a dedicated allowlist; user legs (roles/ManageGuild) don't
    // apply to personas. Spawned hands are excluded upstream (actions.ts).
    return cfg.allowedResidents.includes(invoker.id)
      ? { ok: true }
      : { ok: false, reason: 'this persona is not allow-listed to drive the spawner' };
  }
  if (cfg.allowedUsers.includes(invoker.id)) return { ok: true };
  if (cfg.allowManageGuild && invoker.hasManageGuild) return { ok: true };
  const allowed = new Set([...(cfg.allowedRoles[guildId] ?? []), ...(cfg.allowedRoles['*'] ?? [])]);
  if (allowed.size === 0) {
    return { ok: false, reason: 'you are not allow-listed here — ask the operator to configure cc-spawner' };
  }
  if (invoker.roles === undefined) {
    return { ok: false, reason: 'could not verify your roles' };
  }
  if (invoker.roles.some((r) => allowed.has(r))) return { ok: true };
  return { ok: false, reason: 'you do not hold an allow-listed role' };
}

// ── Portal-side role fetch (list_members + cache) ──

interface CacheEntry {
  roles: string[];
  at: number;
}

const ROLE_CACHE_TTL_MS = 60_000;

export class PortalRoleFetcher {
  private cache = new Map<string, CacheEntry>(); // `${guildId}:${userId}`

  constructor(private readonly client: PortalClient) {}

  /** Role ids for a member, or undefined when they cannot be determined
   *  (roster unavailable / member not found / RPC failure). */
  async fetch(guildId: string, userId: string, username: string): Promise<string[] | undefined> {
    const key = `${guildId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ROLE_CACHE_TTL_MS) return hit.roles;
    try {
      const res = await this.client.call('list_members', { guildId, query: username });
      if (!res.membersAvailable) return undefined; // partial roster — don't trust absence
      const member = res.members.find((m) => m.userId === userId);
      if (!member) return undefined;
      this.cache.set(key, { roles: member.roles, at: Date.now() });
      return member.roles;
    } catch {
      return undefined;
    }
  }
}
