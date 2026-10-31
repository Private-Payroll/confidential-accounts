/**
 * **WHAT A SEAT ACTION ALSO OWES ITS COMPANY, WORKED OUT AND DONE IN THE WALLET, IN THE SAME WINDOW.** Opening a
 * company's pages signs nothing; instead every seat action in this wallet starts by changing the company's key when a
 * removed signer's key is still the one in use, and following a roster no device believes, and ends by filing each
 * vault's records again for the signers seated since its last write, giving each vault's secret to every other seat
 * that lacks it, and anchoring on the chain what was filed. What is
 * owed is worked out from this wallet's own reads: the chain through its own indexer, the company's records as the
 * judges believe them, and the seat in the saved keys. A list the page or the service keeps is never asked.
 * Upkeep never stops the action it rides on for what it could not do; it says so in the action's outcome, and the
 * company's next seat action tries again. A transaction it sent that the service did not confirm does stop the action
 * at that step, since the page must be told what may have gone out.
 */
import type { Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import { peopleServed } from '../../../../src/core/person-record.js';
import { rotateTheCompanyKeyHere, type KeyRotated, type RotationDoors, type SealedAnswer } from '../../../../packages/web-shared/src/company-key-here.js';
import { governedCallServiceFor, seatsLeavingHere } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import {
  anchoredOnTheWayIn, anchorServiceFor, anchorTheRecordsHere, directoryChangeFiledHere, type AnchorDoors,
} from '../../../../packages/web-shared/src/records-anchored-here.js';
import { manifestServiceFor, recordsEnteredFor, treeServiceFor } from '../../../../packages/web-shared/src/record-entered-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { ownEntryFiled, rosterFollowed } from '../../../../packages/web-shared/src/vault-keys-given.js';
import { withoutOwedEntry } from '../../../../packages/web-shared/src/keyring-blob.js';
import {
  browserInFlightRecords, deviceRecordsFor, deviceSignerFrom, directoryFilingsFrom, fileDirectoryFiling, giveEachVaultSecretHere, readersIn,
  type DirectoryHere, type DirectoryRead,
} from '../../../../packages/web-shared/src/vault-page-doors.js';
import { seatHereIn, vaultNotesHere, type RebuildDoors } from '../../../../packages/web-shared/src/vault-operation.js';
import { coinsKeptOnThisDevice, type CoinsKeptHere } from '../../../../packages/web-shared/src/vault-coins-kept-here.js';
import type { InFlightOpener } from '../../../../packages/web-shared/src/in-flight-on-this-device.js';
import { intentShapeOf, routeOf, sendsIn } from 'midnight-identity/profile/request';
import { apiOver, sendOver, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { mayFile } from '../../../../src/midnight/seat-directory.js';

/** Where this wallet keeps the coins it put into a vault; absent where the browser keeps no database. */
export interface UpkeepReach {
  readonly coins?: (opener: InFlightOpener) => CoinsKeptHere | undefined;
}

/** How a step finds the company it acts on, and forgets it so the next read sees what the head step filed or anchored. */
export interface UpkeepCompany {
  readonly reach: (ctx: StepContext) => Promise<CompanyReach>;
  readonly renew: () => void;
}

/** What the outcome says of the upkeep: all of it done, or some of it left for the next seat action. */
export const UPKEEP = { done: 'done', partial: 'partial' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.upkeep.why.${key}`, ...(values === undefined ? {} : { values }),
});

const keptInTheWallet = (opener: InFlightOpener): CoinsKeptHere | undefined =>
  ((globalThis as { indexedDB?: IDBFactory }).indexedDB === undefined ? undefined : coinsKeptOnThisDevice(browserInFlightRecords(), opener));

/**
 * The step's own calls, watched: a stop reaching any of them is kept so that code which swallows errors cannot swallow
 * it, and a call that sends a transaction answered other than with success is counted as not confirmed.
 */
function watchedCalls(ctx: StepContext) {
  const shape = intentShapeOf(ctx.intent.name);
  const seen = { stopped: null as ActionStopped | null, unconfirmed: 0 };
  const watched: Pick<StepContext, 'call'> = {
    call: async (method, path, body) => {
      let answer: Awaited<ReturnType<StepContext['call']>>;
      try {
        answer = await ctx.call(method, path, body);
      } catch (e) {
        if (e instanceof ActionStopped) seen.stopped ??= e;
        throw e;
      }
      const route = shape === undefined ? null : routeOf(shape, method, path);
      if (route !== null && sendsIn(route, body) && (answer.status < 200 || answer.status >= 300)) seen.unconfirmed += 1;
      return answer;
    },
  };
  const api = apiOver(watched);
  const send = sendOver(watched);
  const rethrow = (): void => {
    if (seen.stopped !== null) throw seen.stopped;
    if (ctx.signal.aborted) throw new ActionStopped('stopped');
  };
  return { api, send, seen, rethrow };
}

type Api = ReturnType<typeof apiOver>;
const accountPath = (accountId: string): string => `/api/accounts/${encodeURIComponent(accountId)}`;

/** The roster this device believes, or none, for a read that believes the directory without it. */
const rosterOrNone = (r: CompanyReach) => async () => {
  try {
    return await r.roster();
  } catch {
    return { signers: [] };
  }
};

/**
 * The anchor's doors, every one on this wallet's own reads: the chain's anchors and the account's call state through its
 * own indexer, the directory as its judges believe it, and the seat from the saved keys. The service is asked only for
 * the records and headers the anchor then checks, and to send the proven transaction.
 */
export async function anchorDoorsIn(r: CompanyReach, api: Api): Promise<AnchorDoors> {
  const found = await r.judges.keysFoundFor(r.accountId, r.sealed);
  const service = anchorServiceFor(api);
  return {
    accountId: r.accountId,
    material: { signingSecret: r.seat.signingSecret as Hex, blinding: r.seat.blinding as Hex, scope: r.seat.scope },
    manifest: manifestServiceFor(api),
    tree: treeServiceFor(api),
    ...treeKeptHere(),
    directory: () => r.judges.directoryWithItsRecordsFor(r.accountId, r.label, r.account, found, rosterOrNone(r))(),
    directoryFilings: () => directoryFilingsFrom(api, r.accountId),
    fileDirectory: (filing) => fileDirectoryFiling(api, r.accountId, filing),
    onChain: r.judges.anchorsOnChainFor(r.label, r.account),
    vouching: r.judges.vouchingFor(r.accountId),
    tagSeats: r.judges.tagSeatsFor(r.account),
    service: {
      ...service,
      callState: async () => {
        const chain = await r.chain.callState(r.account);
        if (chain === null) throw new Error('this wallet could not read the company\'s account at one block, so nothing was anchored.');
        return { ...chain, account: r.account };
      },
    },
    builder: r.builder,
  };
}

/**
 * What changing the company's key needs, from this wallet alone: the directory and the rounds on the chain as it reads
 * them, the key this seat was given opened with the seat's own wrapping secret, the company key this wallet derives, and
 * the answers waiting to be carried across. The new key and every seat's copy of it are made inside the change, here.
 */
export async function rotationDoorsIn(r: CompanyReach, api: Api): Promise<RotationDoors> {
  const found = await r.judges.keysFoundFor(r.accountId, r.sealed);
  const records = {
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, found, rosterOrNone(r)),
    roundsOnChain: async (chainIds: readonly string[]) => r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds }),
  };
  const anchor = await anchorDoorsIn(r, api);
  return {
    accountId: r.accountId,
    material: { signingSecret: r.seat.signingSecret },
    records,
    filings: () => directoryFilingsFrom(api, r.accountId),
    served: async () => r.served(),
    released: () => r.companyKey,
    askTheWallet: async () => r.companyKey,
    waiting: async () => {
      const now = await api(accountPath(r.accountId)) as SealedAccount;
      /* A person whose record does not read as one is passed over alone: what waits for them is not folded, and everybody else's is. */
      const people = peopleServed(await api(`${accountPath(r.accountId)}/people`), r.accountId).people;
      const handovers: SealedAnswer[] = [];
      for (const { rec: person, handedOver } of people) {
        if (!handedOver) continue;
        const box = ((await api(`/api/employees/${encodeURIComponent(person.id)}/handover`)) as { inbox?: SealedAnswer } | null)?.inbox;
        if (box !== undefined && box !== null) handovers.push(box);
      }
      return [...(now.pendingSigners ?? []).map((p) => p.sealed as SealedAnswer), ...handovers];
    },
    leaving: () => seatsLeavingHere({ service: governedCallServiceFor(api), accountId: r.accountId, records, leaves: r.judges.leavesFor(r.account) }, found, true),
    admitted: async () => r.judges.seatsAdmittedOn(await api(accountPath(r.accountId)) as SealedAccount),
    file: (change, signedFor) => directoryChangeFiledHere(anchor, change, signedFor),
  };
}

/**
 * What one vault's records are filed again from: this seat, the directory's signers, and the coins this wallet kept.
 * A caller that has already read the directory in this step hands that read in, so it is read once.
 */
export function rebuildDoorsIn(
  ctx: StepContext, r: CompanyReach, api: Api, send: ReturnType<typeof sendOver>, reach: UpkeepReach, read?: DirectoryRead,
): RebuildDoors {
  const person = ctx.person ?? (() => { throw new StepRefused(why('no-person')); })();
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  const directory = read ?? r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const kept = (reach.coins ?? keptInTheWallet)({ signerId: me.signerId, wrappingSecret: me.wrappingSecret });
  return {
    account: r.account,
    builder: r.builder,
    indexer: async () => r.chain.indexer,
    onChain: async () => ({ holders: await r.holders() }),
    me,
    records: deviceRecordsFor(r.seat.signingSecret, judge, () => person, recordsEnteredFor(manifestServiceFor(api), r.accountId, r.seat.signingSecret), send),
    signers: readersIn(directory).signers,
    seatHere: () => seatHereIn(directory, r.seat.signingSecret),
    ...(kept === undefined ? {} : { kept }),
  };
}

/** Anchors what is waiting, this action's own filings among them, even when the company was anchored within the day. */
export async function anchoredAtTheEnd(doors: AnchorDoors): Promise<{ readonly anchored: number } | { readonly notAnchored: string }> {
  const first = await anchoredOnTheWayIn(doors);
  if ('waits' in first) {
    if (first.waits === 'this-seat-does-not-anchor') return { notAnchored: 'this seat\'s role does not anchor the company\'s records; a seat that may anchor them does' };
    try {
      return { anchored: (await anchorTheRecordsHere(doors)).anchored };
    } catch (e) {
      return { notAnchored: (e as Error)?.message ?? String(e) };
    }
  }
  return 'notAnchored' in first ? { notAnchored: first.notAnchored } : { anchored: first.anchored };
}

/**
 * Each vault's secret given to every other seat the chain holds that lacks it, before the anchor so the copies filed
 * are anchored with the action's own records. Each seat and vault is tried alone with `giveEachVaultSecretHere`, which
 * wraps the secret to the records key the seat's believed directory entry names and gives nothing to a seat already
 * holding it. Only a seat this wallet believes, whose role may file a vault's nonce secret, gives: any other seat gives
 * nothing, since every device would refuse the version it filed. A seat with no believed entry yet, a vault this seat
 * holds no copy of, or a filing the service refused is left for the company's next seat action; only a stop ends the
 * step. A stop from a read made through the company's own calls reaches the catch as itself, so it is rethrown there;
 * one the record store wrapped is caught by the watched calls after each pair.
 */
async function vaultSecretsGiven(
  ctx: StepContext, r: CompanyReach, w: ReturnType<typeof watchedCalls>, reach: UpkeepReach,
  vaults: readonly string[], seats: readonly string[], left: () => void,
): Promise<void> {
  const others = [...new Set(seats.map((x) => x.toLowerCase()))].filter((x) => x !== r.leaf.toLowerCase());
  if (vaults.length === 0 || others.length === 0) return;
  const read = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  let once: Promise<DirectoryHere> | null = null;
  const directory = () => (once ??= read());
  let doors: RebuildDoors;
  let mine: { readonly role: Parameters<typeof mayFile>[0]['role'] } | null = null;
  try {
    doors = rebuildDoorsIn(ctx, r, w.api, w.send, reach, directory);
    mine = (await doors.seatHere?.()) ?? null;
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    left();
    return;
  }
  w.rethrow();
  if (mine === null || !mayFile(mine).includes('nonce-secret')) {
    left();
    return;
  }
  for (const seat of others) {
    for (const vault of vaults) {
      try {
        await giveEachVaultSecretHere({ vaultIds: [vault.toLowerCase()], me: doors.me, seat, directory, records: doors.records });
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      w.rethrow();
    }
  }
}

const ROTATED: ReadonlySet<KeyRotated['state']> = new Set(['rotated', 'rotated-elsewhere']);
const NOT_YET_ANCHORED = /not yet anchored/u;
/* What a vault's read says when a record was not filed again for a signer seated since, or who the signers are was not read. */
const NOT_FILED_AGAIN = /not filed again for a signer who cannot open it yet|no record was sealed to more of them/u;

/**
 * The head and the tail of a seat action's steps. The head runs before the action seals anything, because a company
 * whose key is owed a change seals nothing new until it is changed: it files this seat's owed directory entry when
 * asked to and one is kept, changes the company's key when a removal left it owed (anchoring first when the change waits
 * on its own anchor), then follows a roster no device believes. Whenever it anchored or filed anything, the company is
 * read again before the action's own steps, so they seal under what the company's records now hold: a retirement it
 * anchored and could not follow with a change of the key pauses the company for them. The tail files each vault's
 * records again and anchors. Either step stops the action when a transaction it sent was not confirmed.
 */
export function upkeepSteps(company: UpkeepCompany, reach: UpkeepReach, o: { readonly ownEntry?: boolean } = {}) {
  let partial = false;
  const left = (): void => { partial = true; };

  const first: ActionStep = {
    title: { key: 'act.upkeep.step.first' },
    run: async (ctx) => {
      const w = watchedCalls(ctx);
      let r = await company.reach(ctx);
      let changed = false;
      if (o.ownEntry === true && ctx.keyring !== null) {
        try {
          const kept = ctx.keyring.open().read().directoryEntriesOwed?.[r.accountId] ?? null;
          if (kept !== null) {
            const filed = await ownEntryFiled(w.api, r.accountId, {
              read: () => ctx.keyring!.open().read().directoryEntriesOwed?.[r.accountId] ?? null,
              settle: () => ctx.keyring!.keep((k) => withoutOwedEntry(k, r.accountId)),
            }, { signingSecret: r.seat.signingSecret as Hex, companyKeys: r.companyKeys }, async () => (await r.holders()).founding ?? null);
            if (typeof filed === 'object') left();
            if (filed === 'filed') changed = true;
          }
        } catch (e) {
          if (e instanceof ActionStopped) throw e;
          left();
        }
        w.rethrow();
      }
      const rotate = async (): Promise<KeyRotated | null> => {
        try {
          return await rotateTheCompanyKeyHere(await rotationDoorsIn(r, w.api));
        } catch (e) {
          if (e instanceof ActionStopped) throw e;
          return null;
        }
      };
      let rotated = await rotate();
      w.rethrow();
      if (rotated !== null && (rotated.state === 'filed-not-anchored' || (rotated.state === 'waits' && NOT_YET_ANCHORED.test(rotated.why)))) {
        changed = true;
        const anchored = await anchoredAtTheEnd(await anchorDoorsIn(r, w.api)).catch((e: unknown) => {
          if (e instanceof ActionStopped) throw e;
          return { notAnchored: String(e) };
        });
        w.rethrow();
        if ('notAnchored' in anchored) left();
        if (rotated.state === 'waits') rotated = await rotate();
        w.rethrow();
      }
      if (rotated === null || rotated.state === 'not-rotated' || rotated.state === 'filed-not-anchored' || rotated.state === 'waits') left();
      if (rotated === null || rotated.state === 'filed-not-anchored') changed = true;
      if (rotated !== null && ROTATED.has(rotated.state)) {
        company.renew();
        r = await company.reach(ctx);
      }
      try {
        const companyKeys = await r.judges.companyKeysFor(r.accountId, r.sealed, r.seat);
        if (await rosterFollowed({
          api: w.api, accountId: r.accountId, companyKeys, signingSecret: r.seat.signingSecret as Hex, label: r.label, account: r.account,
          reads: r.judges.rosterReadsFor(r.accountId, r.label, r.account),
          entered: recordsEnteredFor(manifestServiceFor(w.api), r.accountId, r.seat.signingSecret as Hex),
        }) !== null) changed = true;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      w.rethrow();
      if (changed) company.renew();
      ctx.tell({ upkeep: partial ? UPKEEP.partial : UPKEEP.done });
      if (w.seen.unconfirmed > 0) throw new StepRefused(why('not-confirmed'));
    },
  };

  const last: ActionStep = {
    title: { key: 'act.upkeep.step.last' },
    run: async (ctx) => {
      const w = watchedCalls(ctx);
      const r = await company.reach(ctx);
      let vaults: readonly string[] = [];
      let seats: readonly string[] = [];
      try {
        const held = await r.holders();
        vaults = held.adoptedVaults;
        seats = held.seats;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      for (const vault of vaults) {
        const notes = await vaultNotesHere(rebuildDoorsIn(ctx, r, w.api, w.send, reach), vault.toLowerCase() as Hex);
        w.rethrow();
        if ((notes.of !== 'as-filed' && notes.of !== 'filed') || notes.said.some((s) => NOT_FILED_AGAIN.test(s))) left();
      }
      await vaultSecretsGiven(ctx, r, w, reach, vaults, seats, left);
      let anchored = 0;
      try {
        const done = await anchoredAtTheEnd(await anchorDoorsIn(r, w.api));
        if ('notAnchored' in done) left(); else anchored = done.anchored;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      w.rethrow();
      ctx.tell({ upkeep: partial ? UPKEEP.partial : UPKEEP.done, anchored });
      if (w.seen.unconfirmed > 0) throw new StepRefused(why('not-confirmed'));
    },
  };

  return { first, last } as const;
}

/** The lines every seat action's window shows before the passkey: what it may also do, as this wallet, never the page, decides. */
export const upkeepShown = (o: { readonly ownEntry?: boolean } = {}): ShownLine[] => [
  { key: 'act.upkeep.shown.may', from: 'action' },
  ...(o.ownEntry === true ? [{ key: 'act.upkeep.shown.entry', from: 'action' as const }] : []),
  { key: 'act.upkeep.shown.rotation', from: 'action' },
  { key: 'act.upkeep.shown.roster', from: 'action' },
  { key: 'act.upkeep.shown.vaults', from: 'action' },
  { key: 'act.upkeep.shown.secrets', from: 'action' },
  { key: 'act.upkeep.shown.anchor', from: 'action' },
];

/** What is checked of the upkeep after the passkey. */
export const UPKEEP_CHECK: Words = Object.freeze({ key: 'act.upkeep.check.worked-out' });
