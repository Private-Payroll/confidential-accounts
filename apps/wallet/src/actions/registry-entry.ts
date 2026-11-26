import { base64 } from '@scure/base';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { openEntry, sealEntry, tagAt, type RegistryEntry } from 'midnight-identity/profile/private-registry';
import { networkName, type NetworkName } from 'midnight-identity/network';
import type { ChainCall, HandOver } from '../../../../packages/web-shared/src/hand-over.js';
import { withRegistryMark, type RegistryMark } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { Hex } from '../../../../src/core/crypto.js';
import type { RightsRecord } from '../../../../src/core/seat-rights.js';
import { networkRecord } from '../../../../src/core/networks.js';
import { takenOrThrown, type FeeSource, type RecordWrite } from '../../../../packages/web-shared/src/records-source.js';
import { REGISTRY_PUT } from '../../../../src/wiring/registry-call-checks.js';
import type { AccountBuilding } from '../chain/account-builder-client.js';
import type { CompanyChain } from './company-reach.js';
import type { ActKeyring, StepContext } from './definition.js';
import { handOverFor, sponsorFor } from './hand-over-in-the-wallet.js';

/**
 * **THIS PERSON'S ENTRY FOR ONE SIGNER SEAT IN THE NETWORK'S PRIVATE REGISTRY: WHETHER IT IS OWED, AND ITS WRITE.**
 *
 * An entry is owed while the page's account is the one pinned for the company, the seat's leaf is seated on it now,
 * and the seat carries no mark that its entry was found written. The write reads the registry once: an entry at one
 * of this person's tags that opens under their words to this company and seat sets the mark, and nothing is sent; a
 * tag holding anything else is passed by, so a tag taken first by anyone sends the write to the next. Otherwise one
 * `put` is built at the lowest free tag and handed over through the one fee path every call of the wallet takes,
 * without waiting for it to land, under a note on the seat, kept before the write leaves, that holds a second send
 * back until a later read finds the entry or the note is a day old. The mark is set from a read of the chain alone, never from a hand-over's answer.
 * Nothing here fails the action: what is not written stays owed for the next time.
 */

/** How long a write handed over and not yet found holds a second write back. */
export const SENT_HOLDS_MS = 24 * 60 * 60_000;
/** How many tags are read at a time, and the most read before the search stops. */
const TAGS_A_READ = 8;
const MOST_TAGS_READ = 256;

const bare = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');

/** The seat as the write needs it: which company and account, its number, scope and rights, its leaf, and its mark. */
export interface SeatToEnter {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: string;
  readonly n: number;
  readonly scope: Hex;
  readonly rights?: RightsRecord;
  readonly leaf: Hex;
  readonly mark?: RegistryMark;
}

/** Whether this seat's entry is owed: the page's account is the pinned one, the seat's leaf is seated now, and no entry was found written for it. */
export function registryEntryOwed(
  seat: Pick<SeatToEnter, 'leaf' | 'mark'>, pin: { readonly pinned: string | null; readonly page: string }, leaves: readonly string[],
): boolean {
  if (pin.pinned === null || bare(pin.pinned) !== bare(pin.page)) return false;
  if (!leaves.some((l) => bare(l) === bare(seat.leaf))) return false;
  return !(seat.mark !== undefined && bare(seat.mark.leaf) === bare(seat.leaf) && seat.mark.written === true);
}

/** What the write reads and sends with. */
export interface RegistryWriteDoors {
  readonly identity: Identity;
  readonly network: NetworkName;
  /** The registries the network lists; the write goes to the first. */
  readonly registries: readonly string[];
  /** The registry's state and the chain's parameters at one block, base64, or null when the chain holds no contract there. */
  readonly read: (registry: string) => Promise<{ readonly registryState: string; readonly parameters: string } | null>;
  readonly build: AccountBuilding;
  /** Where the finished call goes, as every call of the action goes: the fee paid as the person's and company's choice has it. */
  readonly handOver: HandOver;
  readonly keyring: ActKeyring;
  readonly now: () => number;
}

/** How one try at the write ended. */
export type RegistryWrite =
  | { readonly of: 'found' }
  | { readonly of: 'sent'; readonly index: number }
  | { readonly of: 'held'; readonly index: number }
  | { readonly of: 'owed'; readonly why: string };

const entryOf = (seat: SeatToEnter): RegistryEntry => ({
  label: seat.label, account: bare(seat.account), n: seat.n, scope: bare(seat.scope),
  ...(seat.rights === undefined ? {} : { rights: seat.rights }),
});

/** Whether `found` is this seat's entry: this company, its account, and the seat its leaf is drawn from. */
const namesTheSeat = (found: RegistryEntry, seat: SeatToEnter): boolean =>
  found.label === seat.label && found.account === bare(seat.account) && found.n === seat.n && found.scope === bare(seat.scope);

/** The index of this seat's entry among the person's tags, or the lowest free index, read off one state of the registry. */
async function searched(d: RegistryWriteDoors, seat: SeatToEnter, registryState: string): Promise<{ readonly found: number } | { readonly free: number } | null> {
  for (let from = 0; from < MOST_TAGS_READ; from += TAGS_A_READ) {
    const indexes = Array.from({ length: TAGS_A_READ }, (_, i) => from + i);
    const read = await d.build({ ask: 'registry-values', registryState, tags: indexes.map((i) => tagAt(d.identity, d.network, i)) });
    for (const [k, value] of read.values.entries()) {
      if (value === null) return { free: indexes[k]! };
      const opened = openEntry(d.identity, d.network, indexes[k]!, base64.decode(value));
      if (opened !== null && namesTheSeat(opened, seat)) return { found: indexes[k]! };
    }
  }
  return null;
}

/** One try at this seat's entry: read once, then mark, hold or send. Never throws: what fails stays owed. */
export async function registryEntryWritten(d: RegistryWriteDoors, seat: SeatToEnter): Promise<RegistryWrite> {
  try {
    const registry = d.registries[0];
    if (registry === undefined) return { of: 'owed', why: 'this network lists no private registry' };
    const at = await d.read(registry);
    if (at === null) return { of: 'owed', why: 'the chain holds no registry at the address the network lists' };
    const where = await searched(d, seat, at.registryState);
    if (where === null) return { of: 'owed', why: `none of this person's first ${MOST_TAGS_READ} tags is free` };
    if ('found' in where) {
      await d.keyring.keep((k) => withRegistryMark(k, seat.accountId, { leaf: seat.leaf, written: true }));
      return { of: 'found' };
    }
    const sent = seat.mark !== undefined && bare(seat.mark.leaf) === bare(seat.leaf) ? seat.mark.sent : undefined;
    if (sent !== undefined && d.now() - Date.parse(sent.at) < SENT_HOLDS_MS) return { of: 'held', index: sent.index };
    const value = sealEntry(d.identity, d.network, where.free, entryOf(seat));
    const built = await d.build({
      ask: 'registry-put', network: d.network, registry, tag: tagAt(d.identity, d.network, where.free), value: base64.encode(value),
      chain: { registryState: at.registryState, parameters: at.parameters },
    });
    const call: ChainCall = { kind: 'registry-put', contract: registry, circuit: REGISTRY_PUT };
    const send = d.handOver.path === 'service' ? d.handOver.fallback?.toChain : d.handOver.toChain;
    if (d.handOver.refused !== undefined || send === undefined) return { of: 'owed', why: d.handOver.refused ?? 'this wallet has no way to send the write' };
    /* The note is kept before the write leaves, so a write let go after its hand-over still holds a second one back. */
    await d.keyring.keep((k) => withRegistryMark(k, seat.accountId, { leaf: seat.leaf, sent: { index: where.free, at: new Date(d.now()).toISOString() } }));
    try {
      await send(built.tx, call);
    } catch (e) {
      /* Only a write that says nothing of it was sent gives the note back; one that may have gone keeps it. */
      if ((e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true) {
        await d.keyring.keep((k) => withRegistryMark(k, seat.accountId, seat.mark ?? null));
      }
      throw e;
    }
    return { of: 'sent', index: where.free };
  } catch (e) {
    return { of: 'owed', why: String((e as Error)?.message ?? e) };
  }
}

/* The fee routes as the one fee path writes them: an answer that is not a success thrown with its body, as every write is. */
const feeWrites = (fees: FeeSource, company: string) => async (w: RecordWrite): Promise<unknown> => {
  if (w.to !== 'fee' && w.to !== 'fee-done') throw Object.assign(new Error('only the fee routes are written here, so nothing was sent.'), { nothingWasSent: true });
  return takenOrThrown(w.to === 'fee-done' ? await fees.feeDone(company, w.body) : await fees.fee(company, w.body));
};

/** What an action hands the write: its builder, its network, its read of a contract at one block, and the person's own wallet. */
export interface RegistryWriteParts {
  readonly accountId: string;
  readonly network: string;
  readonly build: AccountBuilding;
  readonly read: RegistryWriteDoors['read'];
  readonly ownWallet?: CompanyChain['ownWallet'];
  readonly now: () => number;
}

/**
 * The write of `seat`'s entry, through the context the run hands it after the steps: the fee paid on the one fee path
 * every call takes (`handOverFor`, our sponsorship through `ctx.fees`, the person's own DUST on their yes).
 */
export function registryWriteThrough(ctx: StepContext, parts: RegistryWriteParts, seat: SeatToEnter): Promise<RegistryWrite> {
  if (ctx.keyring === null) return Promise.resolve({ of: 'owed', why: 'the ask carried no saved keys to mark' });
  const sponsor = ctx.fees === undefined ? undefined : sponsorFor(ctx.intent, feeWrites(ctx.fees, parts.accountId));
  const handOver = handOverFor(ctx, { ...(parts.ownWallet === undefined ? {} : { ownWallet: parts.ownWallet }) }, undefined, parts.now, sponsor);
  return registryEntryWritten({
    identity: ctx.held.identity, network: networkName(parts.network), registries: networkRecord(parts.network).registries,
    read: parts.read, build: parts.build, handOver, keyring: ctx.keyring, now: parts.now,
  }, seat);
}
