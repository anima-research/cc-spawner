/**
 * Channel access for spawned bots, via the relay's `mint_invite` RPC (portal
 * PR #15).
 *
 * Previous design edited permissions.json on the relay host over SSH. That was
 * racy by construction: the relay owns those stores in memory, its WatchedFile
 * suppresses reloads by wall-clock window (so an external write inside the
 * window is never read), and any later mutation re-serializes the whole file
 * from stale memory — silently destroying the edit. See portal PR #15.
 *
 * Now: mint a single-use, short-lived, channel-scoped invite in-process on the
 * relay, and enrol the new persona with it. The relay's own applyInviteGrant
 * writes the policy at enrolment, so there is no post-hoc edit to lose.
 *
 * Authorization is subset-of-own-rights: the spawner can only delegate caps it
 * effectively holds on that exact channel. Its reach is the ceiling of its
 * hands' reach — spawning somewhere new needs one `/add cc-spawner` first.
 */
import type { PortalClient } from '@animalabs/portal-client';

const log = (msg: string) => console.log(`${new Date().toISOString()} [grants] ${msg}`);

export interface GrantConfig {
  /** Off ⇒ bots enrol with the static config invite and reach only what it grants. */
  enabled: boolean;
  /** Capabilities delegated to a spawned bot on its home channel. Must be a
   *  subset of what the spawner itself holds there, or the relay rejects it. */
  caps: string[];
  /** Lifetime of the minted code. Clamped to [1,60] by the relay. */
  expiresInMinutes: number;
}

export class ChannelInviteMinter {
  constructor(
    private readonly client: PortalClient,
    private readonly cfg: GrantConfig,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Mint a code granting exactly this channel. Returns undefined when disabled
   * (caller falls back to the static invite). Throws with an operator-actionable
   * message when the relay refuses.
   */
  async mintForChannel(guildId: string, channelId: string, personaName: string): Promise<string | undefined> {
    if (!this.cfg.enabled) {
      log(`disabled — ${personaName} will enrol with the static invite`);
      return undefined;
    }
    // Delegate the INTERSECTION of what we want and what we actually hold here.
    // A fixed cap list breaks the moment a channel grants the spawner less than
    // the wish-list (the relay refuses the whole mint), and asking for less than
    // we hold is the least-privilege default anyway.
    const caps = await this.delegatableCaps(guildId, channelId);
    try {
      const { code, expiresAt } = await this.client.mintInvite({
        grant: { caps: caps as never, scope: { channels: [channelId] } },
        guildId,
        maxUses: 1,
        expiresInMinutes: this.cfg.expiresInMinutes,
        label: `cc-spawner → ${personaName}`,
      });
      log(`minted ${code.slice(0, 12)}… for ${personaName} on ${channelId} (expires ${expiresAt})`);
      return code;
    } catch (err) {
      throw new Error(this.explain(err as Error, channelId));
    }
  }

  /**
   * Wish-list ∩ our own effective caps on that channel, authoritative from the
   * relay (list_channels reports the caller's per-channel capabilities). Throws
   * with the bootstrap instruction when we can't cover a working bot.
   */
  private async delegatableCaps(guildId: string, channelId: string): Promise<string[]> {
    const { channels } = await this.client.call('list_channels', { guildId });
    const own = new Set(channels.find((c) => c.id === channelId)?.capabilities ?? []);
    const caps = this.cfg.caps.filter((c) => own.has(c as never));
    // Without these a bot can't read the room or answer in it — no point booting.
    const essential = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'];
    const missing = essential.filter((c) => !own.has(c as never));
    if (missing.length) {
      throw new Error(
        `I lack ${missing.join(', ')} on <#${channelId}>, so I can't delegate a working bot there — run \`/add cc-spawner\` in this channel first, then retry.`,
      );
    }
    const dropped = this.cfg.caps.filter((c) => !own.has(c as never));
    if (dropped.length) log(`not delegating ${dropped.join(', ')} on ${channelId} — I don't hold them`);
    return caps;
  }

  /** Turn relay rejections into something an operator can act on. */
  private explain(err: Error, channelId: string): string {
    const m = err.message;
    if (/does not hold them|could not be re-verified/.test(m)) {
      return `I don't have the rights to delegate on <#${channelId}> — run \`/add cc-spawner\` in this channel first, then retry. (relay: ${m})`;
    }
    if (/not an authorized invite minter/.test(m)) {
      return `the relay hasn't authorized me to mint invites — add my persona id to PORTAL_INVITE_MINTERS in relay.env and restart the relay. (relay: ${m})`;
    }
    if (/rate limit/.test(m)) return `minting is rate-limited right now — retry in a few seconds. (relay: ${m})`;
    if (/too many outstanding/.test(m)) {
      return `too many unclaimed invites outstanding — they expire on their own; retry shortly. (relay: ${m})`;
    }
    if (/allow-list/.test(m)) return `this guild isn't on the relay's allow-list. (relay: ${m})`;
    return `could not mint a channel invite: ${m}`;
  }
}
