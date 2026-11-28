/**
 * **WHAT A SEAT ACTION ALSO OWES ITS COMPANY, WORKED OUT AND DONE IN THE WALLET, IN THE SAME WINDOW.** Opening a
 * company's pages signs nothing; instead every seat action in this wallet starts by changing the company's key when a
 * removed signer's key is still the one in use, and following a roster no device believes, and ends by filing each
 * vault's records again for the signers seated since its last write, giving each vault's secret to every other seat
 * that lacks it, sealing each spending policy in force again to them, and anchoring on the chain what was filed. What is
 * owed is worked out from this wallet's own reads: the chain through its own indexer, the company's records as the
 * judges believe them, and the seat in the saved keys. A list the page or the service keeps is never asked.
 * Upkeep never stops the action it rides on for what it could not do; it says so in the action's outcome, and the
 * company's next seat action tries again. A transaction it sent that the service did not confirm does stop the action
 * at that step, since the page must be told what may have gone out.
 */
import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import { peopleServed } from '../../../../src/core/person-record.js';
import {
  rotateTheCompanyKeyHere,
  type KeyRotated,
  type RotationDoors,
  type SealedAnswer
} from '../../../../packages/web-shared/src/company-key-here.js';
import { grantsReadWith, revokedAtHere } from '../../../../packages/web-shared/src/purpose-wraps.js';
import { grantsWrappedAgainHere } from '../../../../packages/web-shared/src/grants-filed-here.js';
import { grantsFilingDoorsIn } from './grant-read.js';
import { withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { governedCallServiceThrough } from '../../../../packages/web-shared/src/governed-call-through-the-view.js';
import { anchorServiceThrough } from '../../../../packages/web-shared/src/anchored-through-the-view.js';
import { seatsLeavingHere } from '../../../../packages/web-shared/src/seats-leaving-here.js';
import { anchorTheRecordsHere, type AnchorDoors } from '../../../../packages/web-shared/src/records-anchored-here.js';
import {
  anchoredOnTheWayIn,
  directoryChangeFiledHere
} from '../../../../packages/web-shared/src/anchored-on-the-way-in.js';
import { sealPoliciesToNewSignersHere } from '../../../../packages/web-shared/src/policies-resealed-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import {
  keepRecoveryWindowHere,
  recoveryWindowHere
} from '../../../../packages/web-shared/src/recovery-window-here.js';
import { ownEntryFiled, rosterFollowed } from '../../../../packages/web-shared/src/vault-keys-given.js';
import { withoutOwedEntry } from '../../../../packages/web-shared/src/keyring-blob.js';
import { browserInFlightRecords } from '../../../../packages/web-shared/src/in-flight-in-this-browser.js';
import {
  deviceRecordsFor,
  deviceSignerFrom,
  readersIn,
  type DirectoryHere,
  type DirectoryRead
} from '../../../../packages/web-shared/src/vault-page-doors.js';
import { readsJoinedIn } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { VaultRecordsHeld } from '../../../../packages/web-shared/src/vault-records-filed-together.js';
import type { CompanyView } from '../../../../packages/web-shared/src/company-view.js';
import { serviceSource, type RecordWrite } from '../../../../packages/web-shared/src/records-source.js';
import { stopsFor } from './leaving-read-in-the-wallet.js';
import { giveEachVaultSecretHere } from '../../../../packages/web-shared/src/vault-secret-given.js';
import {
  seatHereIn,
  unnamedKeptIn,
  vaultNotesHere,
  type RebuildDoors
} from '../../../../packages/web-shared/src/vault-notes-here.js';
import {
  coinsKeptOnThisDevice,
  type CoinsKeptHere
} from '../../../../packages/web-shared/src/vault-coins-kept-here.js';
import type { InFlightOpener } from '../../../../packages/web-shared/src/in-flight-on-this-device.js';
import { intentShapeOf, routeOf, sendsIn } from 'midnight-identity/profile/request';
import { enteredFor, governanceRecordsFor, rosterOrNone, type CompanyReach } from './company-reach.js';
import { type Handed } from './hand-over-in-the-wallet.js';
import { leavingForTheAnchor } from './leaving-read-in-the-wallet.js';
import { policiesInTheWallet } from './policy-doors-in-the-wallet.js';
import { StepRefused, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { mayFile } from '../../../../src/midnight/seat-directory.js';
import { WIRE_RECORDS } from '../../../../src/midnight/sealed-record-wire.js';
import { vaultSecretsKeptFor } from './vault-secret-kept.js';
import type { VaultDoorsReach } from './vault-doors-here.js';
import { stillOwed, vaultSecretsChangedHere } from './vault-secrets-changed-here.js';
import { retiredVaultsKeptHere } from './retired-vaults-here.js';
import { signerMaterialOf } from '../../../../packages/web-shared/src/private-state.js';
import { seatsWithNoRightsRead } from './approvers-here.js';

/** Where this wallet keeps the coins it put into a vault; absent where the browser keeps no database. */
export interface UpkeepReach {
  readonly coins?: (opener: InFlightOpener) => CoinsKeptHere | undefined;
  /** Where this wallet keeps a vault's new secret and its run, to finish a change of it; absent, the wallet's own store. */
  readonly vaultSecrets?: VaultDoorsReach;
}

/** How a step finds the company it acts on, and forgets it so the next read sees what the head step filed or anchored. */
export interface UpkeepCompany {
  readonly reach: (ctx: StepContext) => Promise<CompanyReach>;
  readonly renew: () => void;
}

/** What the outcome says of the upkeep: all of it done, or some of it left for the next seat action. */
export const UPKEEP = { done: 'done', partial: 'partial' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.upkeep.why.${key}`,
  ...(values === undefined ? {} : { values })
});

const keptInTheWallet = (opener: InFlightOpener): CoinsKeptHere | undefined =>
  (globalThis as { indexedDB?: IDBFactory }).indexedDB === undefined
    ? undefined
    : coinsKeptOnThisDevice(browserInFlightRecords(), opener);

/** A pause that ends early, as stopped, when the action is stopped. */
const pauseUntil = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ActionStopped('stopped'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stopped);
      resolve();
    }, ms);
    const stopped = (): void => {
      clearTimeout(timer);
      reject(new ActionStopped('stopped'));
    };
    signal.addEventListener('abort', stopped, { once: true });
  });

/** The wallet's own store of a vault's new secret, where there is one; the change reads no indexer of its own. */
const vaultSecretsInTheWallet = (): VaultDoorsReach | undefined =>
  (globalThis as { localStorage?: Storage }).localStorage === undefined
    ? undefined
    : { secrets: (person) => vaultSecretsKeptFor(person), pause: pauseUntil, indexerHttp: '' };

/** The method, path and body a write goes out with, as the company's source sends it. */
const sentAs = async (
  company: string,
  w: RecordWrite
): Promise<{ readonly method: string; readonly path: string; readonly body: string | undefined }> => {
  let out = { method: 'GET', path: '', body: undefined as string | undefined };
  await serviceSource(async (path, init) => {
    out = { method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? init.body : undefined };
    return {};
  }, company).write(w);
  return out;
};

/**
 * The step's view of the company, watched: a stop reaching any read or write through it is kept so that code which
 * swallows errors cannot swallow it, and a write that sends a transaction answered other than with success is counted
 * as not confirmed.
 */
function watchedSteps(ctx: StepContext) {
  const shape = intentShapeOf(ctx.intent.name);
  const seen = { stopped: null as ActionStopped | null, unconfirmed: 0 };
  const sends = (method: string, path: string, body: string | undefined): boolean => {
    const route = shape === undefined ? null : routeOf(shape, method, path);
    return route !== null && sendsIn(route, body);
  };
  const rethrow = (): void => {
    if (seen.stopped !== null) throw seen.stopped;
    if (ctx.signal.aborted) throw new ActionStopped('stopped');
  };
  /*
   * A write the service answered other than with success, counted when that write itself sends a transaction. A refusal
   * the view's check made before anything of the batch left (`thisSendNotSent`) sent nothing, and is not counted.
   */
  const unsent = async (company: string, e: unknown): Promise<void> => {
    const failed = e as { status?: unknown; thisSendNotSent?: unknown; failedWrite?: RecordWrite } | null;
    if (typeof failed?.status !== 'number' || failed.thisSendNotSent === true || failed.failedWrite === undefined)
      return;
    const out = await sentAs(company, failed.failedWrite);
    if (sends(out.method, out.path, out.body)) seen.unconfirmed += 1;
  };
  const caught = (e: unknown): void => {
    if (e instanceof ActionStopped) seen.stopped ??= e;
  };
  const watchedView = <H>(view: CompanyView<H>): CompanyView<H> =>
    new Proxy(view, {
      get: (v, name) => {
        const got: unknown = Reflect.get(v, name);
        if (typeof got !== 'function') return got;
        return (...args: unknown[]): unknown => {
          const out: unknown = (got as (...a: unknown[]) => unknown).apply(v, args);
          if (!(out instanceof Promise)) return out;
          return out.catch(async (e: unknown) => {
            caught(e);
            if (name === 'write') await unsent(v.company, e);
            throw e;
          });
        };
      }
    });
  /* `r` with its view of the company watched: every door the step hands that view to is watched with it. */
  const watching = (r: CompanyReach): CompanyReach => {
    const held = r.stepView;
    return {
      ...r,
      stepView: { current: () => watchedView(held.current()), again: (why) => watchedView(held.again(why)) }
    };
  };
  return { seen, rethrow, watching };
}

/**
 * The anchor's doors, every one through the step's view of the company (`r.stepView`) or this wallet's own reads: the
 * chain's anchors and the account's call state, the proposals, the founding records and the records and headers the
 * anchor then checks all through the view, the directory as its judges believe it, and the seat from the saved keys.
 * The proven transaction is sent through the view's write unless the act sends its calls straight to the chain
 * (`handOverFor`). Who is leaving is read on the same reads (`leavingForTheAnchor`); when it cannot
 * be read, or a proposal this wallet cannot open was passed over in reading it, the anchor binds only what it read and
 * retirements already anchored, and `unread` is told why so the act says it was left partial.
 */
export async function anchorDoorsIn(r: CompanyReach, unread?: (why: string) => void): Promise<AnchorDoors> {
  const found = await r.judges.keysFoundFor(r.accountId, r.sealed);
  return {
    accountId: r.accountId,
    material: signerMaterialOf(r.seat),
    manifest: r.stepView.current().manifest,
    tree: r.stepView.current().tree,
    ...treeKeptHere(),
    directory: () => r.stepView.current().directory(),
    directoryFilings: () => r.stepView.current().filings(),
    fileDirectory: async (filing) => {
      await r.stepView.current().write([{ to: 'directory', filing }]);
    },
    onChain: () => r.stepView.current().doors.onChain(),
    vouching: r.judges.vouchingFor(r.accountId),
    tagSeats: r.judges.tagSeatsFor(r.account),
    leaving: leavingForTheAnchor(r, found, unread),
    service: anchorServiceThrough(r.stepView),
    builder: r.builder,
    ...(r.handOver === undefined ? {} : { handOver: r.handOver }),
    view: r.stepView
  };
}

/**
 * The door a change that raises the approvals needed asks to anchor the company's directory first, so a directory
 * change filed and not yet anchored is never counted at the higher number. Marks the press as having sent something.
 */
export const anchorDirectoryDoorIn = (r: CompanyReach, handed: Handed) => async (): Promise<unknown> => {
  handed.over = true;
  return anchorTheRecordsHere(await anchorDoorsIn(r));
};

/**
 * What changing the company's key needs, from this wallet alone: the directory and the rounds on the chain as it reads
 * them, the key this seat was given opened with the seat's own wrapping secret, the company key this wallet derives, and
 * the answers waiting to be carried across. The new key and every seat's copy of it are made inside the change, here.
 */
export async function rotationDoorsIn(r: CompanyReach): Promise<RotationDoors> {
  const found = await r.judges.keysFoundFor(r.accountId, r.sealed);
  const records = {
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, found, rosterOrNone(r.roster)),
    roundsOnChain: async (chainIds: readonly string[]) =>
      r.builder.roundsOnChain({
        account: r.account,
        indexer: r.chain.indexer,
        chainIds,
        seat: r.seat.signingSecret
      })
  };
  const anchor = await anchorDoorsIn(r);
  return {
    accountId: r.accountId,
    material: { signingSecret: r.seat.signingSecret },
    records,
    filings: () => r.stepView.current().filings(),
    served: async () => r.served(),
    released: () => r.companyKey,
    askTheWallet: async () => r.companyKey,
    waiting: async () => {
      const view = r.stepView.current();
      const now = (await view.account()) as SealedAccount;
      /* A person whose record does not read as one is passed over alone: what waits for them is not folded, and everybody else's is. */
      const handedOver = peopleServed(await view.list('people'), r.accountId)
        .people.filter((p) => p.handedOver)
        .map((p) => p.rec.id);
      const boxes = handedOver.length === 0 ? [] : await view.handovers(handedOver);
      const handovers = boxes
        .map((b) => (b as { inbox?: SealedAnswer | null } | null)?.inbox)
        .filter((b): b is SealedAnswer => b !== undefined && b !== null);
      return [...(now.pendingSigners ?? []).map((p) => p.sealed as SealedAnswer), ...handovers];
    },
    leaving: () =>
      seatsLeavingHere(
        {
          service: governedCallServiceThrough(r.stepView),
          accountId: r.accountId,
          records,
          leaves: r.judges.leavesFor(r.account)
        },
        found,
        true
      ),
    admitted: async () => r.judges.seatsAdmittedOn((await r.stepView.current().account()) as SealedAccount),
    file: (change, signedFor) => directoryChangeFiledHere(anchor, change, signedFor),
    revoked: () =>
      revokedAtHere({
        accountId: r.accountId,
        versions: grantsReadWith((asked) => r.stepView.current().records(asked), r.accountId),
        directory: records.directory,
        signingPublicKey: signingPublicKeyOf(r.seat.signingSecret as Hex),
        released: async () => r.companyKey
      })
  };
}

/**
 * What one vault's records are filed again from: this seat, the directory's signers, and the coins this wallet kept.
 * A caller that has already read the directory in this step hands that read in, so it is read once. With `held`, what
 * the records filed waits there to be sent with the step's other vault filings as one checked batch.
 */
export function rebuildDoorsIn(
  ctx: StepContext,
  r: CompanyReach,
  reach: UpkeepReach,
  read?: DirectoryRead,
  held?: VaultRecordsHeld
): RebuildDoors {
  if (ctx.person === null) throw new StepRefused(why('no-person'));
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  const directory = read ?? r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const kept = (reach.coins ?? keptInTheWallet)({ signerId: me.signerId, wrappingSecret: me.wrappingSecret });
  return {
    account: r.account,
    builder: r.builder,
    indexer: async () => r.chain.indexer,
    vaultsHere: r.vaultsHere,
    onChain: async () => ({ holders: await r.holders() }),
    me,
    records: deviceRecordsFor(r.seat.signingSecret, judge, {
      ...readsJoinedIn(r.stepView, stopsFor(r)),
      ...(held === undefined ? {} : { held })
    }),
    signers: readersIn(directory).signers,
    seatHere: () => seatHereIn(directory, r.seat.signingSecret),
    ...unnamedKeptIn(r.stepView.current()),
    ...(kept === undefined ? {} : { kept })
  };
}

/** Anchors what is waiting, this action's own filings among them, even when the company was anchored within the day. */
export async function anchoredAtTheEnd(
  doors: AnchorDoors
): Promise<{ readonly anchored: number } | { readonly notAnchored: string }> {
  const first = await anchoredOnTheWayIn(doors);
  if ('waits' in first) {
    if (first.waits === 'this-seat-does-not-anchor')
      return {
        notAnchored: "this seat's role does not anchor the company's records; a seat that may anchor them does"
      };
    try {
      return { anchored: (await anchorTheRecordsHere(doors)).anchored };
    } catch (e) {
      return { notAnchored: (e as Error)?.message ?? String(e) };
    }
  }
  return 'notAnchored' in first ? { notAnchored: first.notAnchored } : { anchored: first.anchored };
}

/**
 * The vault filings the step held back, sent as one checked batch. One refused, not known or not sent after a refusal
 * is left for the company's next seat action, which files it again. A pool version another seat filed first is left
 * too: the notes this seat found are not in the pool the other seat filed, and the batch is past the point where the
 * rebuild could read the pool again, so the next seat action rebuilds them over it. Only a stop ends the step.
 */
export async function heldFilingsSent(held: Pick<VaultRecordsHeld, 'sent'>, left: () => void): Promise<void> {
  for (const { outcome } of await held.sent()) {
    if (outcome.status === 'fulfilled') continue;
    if (outcome.reason instanceof ActionStopped) throw outcome.reason;
    left();
  }
}

/**
 * Each vault's secret given to every other seat the chain holds that lacks it, before the anchor so the copies filed
 * are anchored with the action's own records. Each vault is tried alone with `giveEachVaultSecretHere`, which files
 * one version per vault wrapping the secret to the records key each lacking seat's believed directory entry names, and
 * gives nothing to a seat already holding it. Only a seat this wallet believes, whose role may file a vault's nonce
 * secret, gives: any other seat gives nothing, since every device would refuse the version it filed. A seat the give
 * skipped (no believed entry yet, or not one this device believes), a vault this seat holds no copy of, or a filing the
 * service refused is left for the company's next seat action; only a stop ends the step. With `held`, each vault's
 * version waits there and is sent with the step's other vault filings (`heldFilingsSent`). A stop from a read made
 * through the company's own calls reaches the catch as itself, so it is rethrown there; one the record store wrapped is
 * caught by the watched calls after each vault.
 */
async function vaultSecretsGiven(
  ctx: StepContext,
  r: CompanyReach,
  w: ReturnType<typeof watchedSteps>,
  reach: UpkeepReach,
  vaults: readonly string[],
  seats: readonly string[],
  left: () => void,
  held?: VaultRecordsHeld
): Promise<void> {
  const others = [...new Set(seats.map((x) => x.toLowerCase()))].filter((x) => x !== r.leaf.toLowerCase());
  if (vaults.length === 0 || others.length === 0) return;
  const read = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  let once: Promise<DirectoryHere> | null = null;
  const directory = () => (once ??= read());
  let doors: RebuildDoors;
  let mine: { readonly role: Parameters<typeof mayFile>[0]['role'] } | null = null;
  try {
    doors = rebuildDoorsIn(ctx, r, reach, directory, held);
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
  for (const vault of vaults) {
    try {
      const done = await giveEachVaultSecretHere({
        vaultIds: [vault.toLowerCase()],
        me: doors.me,
        seats: others,
        directory,
        records: doors.records
      });
      if (done.skipped.length > 0) left();
    } catch (e) {
      if (e instanceof ActionStopped) throw e;
      left();
    }
    w.rethrow();
  }
}

/**
 * **A VAULT SECRET'S CHANGE THAT STOPPED PART WAY IS FINISHED**: for each vault, the copies of a secret the chain holds
 * are written, a secret the chain holds is filed, and a run this seat raised or approved, kept in this wallet and at its
 * approvals, is carried (`vaultSecretsChangedHere` with `finish`). It raises nothing, approves nothing and refuses
 * nothing: a vault still owed a change leaves the upkeep partial, and a signer who stays changes it by a press. The
 * retired vaults are the step's own read of them, handed on so the change does not read them again.
 */
async function vaultSecretsFinished(
  ctx: StepContext,
  r: CompanyReach,
  w: ReturnType<typeof watchedSteps>,
  reach: UpkeepReach,
  vaults: { readonly adopted: readonly string[]; readonly retired: readonly string[] },
  left: () => void
): Promise<void> {
  if (vaults.adopted.length === 0 && vaults.retired.length === 0) return;
  const kept = reach.vaultSecrets ?? vaultSecretsInTheWallet();
  if (kept === undefined) {
    left();
    return;
  }
  try {
    const retired = vaults.retired.map((v) => v.toLowerCase() as Hex);
    if (stillOwed(await vaultSecretsChangedHere(ctx, r, kept, await rotationDoorsIn(r), 'finish', { retired }))) left();
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    left();
  }
  w.rethrow();
}

/**
 * Each spending policy in force whose version in force is not believed or leaves out a signer who stays sealed again
 * to every signer this wallet believes and every policy reader, after the act's own admission and before the anchor so
 * what it files is anchored with the act's own records. Every policy sealed again is sent as one checked batch of its
 * own, after the vault filings' batch; one another seat filed first is passed over and left for the next seat action. A seat that may not file a policy (its role, or a seat this
 * wallet does not believe) seals none and names each policy a seat that may still owes a seal; a policy this wallet
 * could not seal again, or a read that failed, is said. Either leaves the upkeep partial for the next seat action that
 * runs the upkeep. What it left alone because nothing was owed is not said.
 */
async function policiesSealedAgain(
  ctx: StepContext,
  r: CompanyReach,
  w: ReturnType<typeof watchedSteps>,
  left: () => void
): Promise<void> {
  let notSealed: readonly string[];
  let owed: readonly string[] = [];
  try {
    const done = await sealPoliciesToNewSignersHere(
      withCompanyKeys(
        {
          records: { ...governanceRecordsFor(r), spendingPolicies: policiesInTheWallet(r, { files: true }) },
          accountId: r.accountId,
          keyEpoch: r.companyKeys.epoch,
          filingKey: signingPublicKeyOf(r.seat.signingSecret as Hex)
        },
        r.companyKeys
      )
    );
    notSealed = done.refused.map((x) => `${x.id}: ${x.why}`);
    owed = done.owed;
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    notSealed = [String((e as Error)?.message ?? e)];
  }
  w.rethrow();
  if (notSealed.length > 0 || owed.length > 0) left();
  if (notSealed.length > 0)
    ctx.show({ key: 'act.upkeep.left.policies-not-sealed', values: { policies: notSealed.join('; ') } });
  if (owed.length > 0) ctx.show({ key: 'act.upkeep.left.policies-owed', values: { policies: owed.join(', ') } });
}

/**
 * Every adopted vault's records named to the step's view and read in one request, so the vaults' stores read them from
 * the view's one answer, and its one held read proves them all, however many vaults the company holds.
 */
const vaultRecordsDeclared = async (r: CompanyReach, vaults: readonly string[]): Promise<void> => {
  if (vaults.length === 0) return;
  r.vaultsHere.declare(vaults);
  const asked = vaults.flatMap((v) => WIRE_RECORDS.map((record) => ({ vault: v.toLowerCase(), record })));
  try {
    const view = r.stepView.current();
    view.declare({ records: asked.map((a) => ({ store: 'vault' as const, kind: a.record, id: a.vault })) });
    await view.vaultRecords(asked);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    /* Nothing is kept from a read that failed: each vault's own read below reads its records again and says what it could not. */
  }
};

const ROTATED: ReadonlySet<KeyRotated['state']> = new Set(['rotated', 'rotated-elsewhere']);
const NOT_YET_ANCHORED = /not yet anchored/u;

/**
 * The head and the tail of a seat action's steps. The head runs before the action seals anything, because a company
 * whose key is owed a change seals nothing new until it is changed: it files this seat's owed directory entry when
 * asked to and one is kept, changes the company's key when a removal left it owed (anchoring first when the change waits
 * on its own anchor), then follows a roster no device believes. Whenever it anchored or filed anything, the company is
 * read again before the action's own steps, so they seal under what the company's records now hold: a retirement it
 * anchored and could not follow with a change of the key pauses the company for them. The tail files each vault's
 * records again, gives each vault's secret, seals each spending policy again, and anchors. Either step stops the action when a transaction it sent was not confirmed.
 */
export function upkeepSteps(company: UpkeepCompany, reach: UpkeepReach, o: { readonly ownEntry?: boolean } = {}) {
  let partial = false;
  const offersRefused: string[] = [];
  /* Something left for the next seat action; an offer of vault keys the fold refused is named, seat and reason, to the person in this window. */
  const left = (offerRefused?: string): void => {
    partial = true;
    if (offerRefused !== undefined) offersRefused.push(offerRefused);
  };
  /* Why who is leaving went unread for the anchor: its own line with its own remedy, said once for each step. */
  const leavingUnread = (ctx: StepContext) => {
    const said = new Set<string>();
    return (why: string): void => {
      partial = true;
      if (said.has(why)) return;
      said.add(why);
      ctx.show({ key: 'act.upkeep.left.leaving-unread', values: { why } });
    };
  };

  const first: ActionStep = {
    title: { key: 'act.upkeep.step.first' },
    run: async (ctx) => {
      const w = watchedSteps(ctx);
      let r = w.watching(await company.reach(ctx));
      let changed = false;
      if (o.ownEntry === true && ctx.keyring !== null) {
        try {
          const kept = ctx.keyring.open().read().directoryEntriesOwed?.[r.accountId] ?? null;
          if (kept !== null) {
            const filed = await ownEntryFiled(
              r.accountId,
              {
                read: () => ctx.keyring!.open().read().directoryEntriesOwed?.[r.accountId] ?? null,
                settle: () => ctx.keyring!.keep((k) => withoutOwedEntry(k, r.accountId))
              },
              { signingSecret: r.seat.signingSecret as Hex, companyKeys: r.companyKeys },
              async () => (await r.holders()).founding ?? null,
              r.stepView
            );
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
          return await rotateTheCompanyKeyHere(await rotationDoorsIn(r));
        } catch (e) {
          if (e instanceof ActionStopped) throw e;
          return null;
        }
      };
      let rotated = await rotate();
      w.rethrow();
      if (
        rotated !== null &&
        (rotated.state === 'filed-not-anchored' || (rotated.state === 'waits' && NOT_YET_ANCHORED.test(rotated.why)))
      ) {
        changed = true;
        const anchored = await anchoredAtTheEnd(await anchorDoorsIn(r, leavingUnread(ctx))).catch((e: unknown) => {
          if (e instanceof ActionStopped) throw e;
          return { notAnchored: String(e) };
        });
        w.rethrow();
        if ('notAnchored' in anchored) left();
        if (rotated.state === 'waits') rotated = await rotate();
        w.rethrow();
      }
      if (
        rotated === null ||
        rotated.state === 'not-rotated' ||
        rotated.state === 'filed-not-anchored' ||
        rotated.state === 'waits'
      )
        left();
      if (rotated === null || rotated.state === 'filed-not-anchored') changed = true;
      if (rotated !== null && ROTATED.has(rotated.state)) {
        company.renew();
        r = w.watching(await company.reach(ctx));
      }
      /* The read grants in force, wrapped again to the company's newest key and sealed to every seat, when owed. */
      const rewrapped = await grantsWrappedAgainHere(grantsFilingDoorsIn(r)).catch((e: unknown) => {
        if (e instanceof ActionStopped) throw e;
        return { state: 'not-wrapped' as const, why: String(e) };
      });
      w.rethrow();
      if (rewrapped.state === 'not-wrapped') left();
      if (rewrapped.state === 'filed') changed = true;
      try {
        const companyKeys = await r.judges.companyKeysFor(r.accountId, r.sealed, r.seat);
        const followed = await rosterFollowed({
          accountId: r.accountId,
          companyKeys,
          signingSecret: r.seat.signingSecret as Hex,
          label: r.label,
          account: r.account,
          reads: r.judges.rosterReadsFor(r.accountId, r.label, r.account),
          entered: enteredFor(r),
          view: r.stepView
        });
        if (followed.changed) changed = true;
        for (const offer of followed.refused) left(`seat ${offer.seat}: ${offer.why}`);
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      w.rethrow();
      /* A seat whose rights this wallet cannot read yet is counted on no vault; the person is told which, and what clears it. */
      const unread = await seatsWithNoRightsRead(r).catch((e: unknown) => {
        if (e instanceof ActionStopped) throw e;
        left();
        return [];
      });
      w.rethrow();
      if (changed) company.renew();
      ctx.tell({ upkeep: partial ? UPKEEP.partial : UPKEEP.done });
      if (offersRefused.length > 0)
        ctx.show({ key: 'act.upkeep.left.vault-keys-refused', values: { offers: offersRefused.join('; ') } });
      if (unread.length > 0)
        ctx.show({ key: 'act.upkeep.left.seat-rights-unread', values: { seats: unread.join(', ') } });
      if (w.seen.unconfirmed > 0) throw new StepRefused(why('not-confirmed'));
    }
  };

  const last: ActionStep = {
    title: { key: 'act.upkeep.step.last' },
    run: async (ctx) => {
      const w = watchedSteps(ctx);
      const r = w.watching(await company.reach(ctx));
      let vaults: readonly string[] = [];
      let retired: readonly string[] = [];
      let seats: readonly string[] = [];
      try {
        const held = await r.holders();
        vaults = held.adoptedVaults;
        seats = held.seats;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      /* Read once for the whole step; one that cannot be read leaves the upkeep partial and holds back no adopted vault's work. */
      try {
        retired = await retiredVaultsKeptHere(r, {
          builder: r.builder,
          indexer: async () => r.chain.indexer,
          account: r.account
        });
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      await vaultRecordsDeclared(r, vaults);
      /* Every vault's records and secret copies are filed together after they are all read: one check, then each in order. */
      const held = new VaultRecordsHeld((writes) => r.stepView.current().write(writes));
      for (const vault of vaults) {
        const notes = await vaultNotesHere(rebuildDoorsIn(ctx, r, reach, undefined, held), vault.toLowerCase() as Hex);
        w.rethrow();
        if ((notes.of !== 'as-filed' && notes.of !== 'filed') || (notes.unsealed ?? []).length > 0) left();
      }
      /*
       * A retired vault whose secret is still kept (it may hold private money, or its last secret change is half written:
       * the rule the change of the vault secrets reads by) has its secret's change finished and its secret given as an
       * adopted vault's are; one that never started is passed over.
       */
      await vaultSecretsFinished(ctx, r, w, reach, { adopted: vaults, retired }, left);
      await vaultSecretsGiven(ctx, r, w, reach, [...vaults, ...retired], seats, left, held);
      await heldFilingsSent(held, left);
      w.rethrow();
      await policiesSealedAgain(ctx, r, w, left);
      let anchored = 0;
      try {
        const done = await anchoredAtTheEnd(await anchorDoorsIn(r, leavingUnread(ctx)));
        if ('notAnchored' in done) left();
        else anchored = done.anchored;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        left();
      }
      w.rethrow();
      const window = await keepRecoveryWindowHere(
        r.accountId,
        () => recoveryWindowHere(r, { anchoredOnly: true }),
        treeKeptHere()
      ).catch((e: unknown) => {
        if (e instanceof ActionStopped) throw e;
        return null;
      });
      if (window?.unread !== undefined) left();
      w.rethrow();
      ctx.tell({ upkeep: partial ? UPKEEP.partial : UPKEEP.done, anchored });
      if (w.seen.unconfirmed > 0) throw new StepRefused(why('not-confirmed'));
    }
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
  { key: 'act.upkeep.shown.finish', from: 'action' },
  { key: 'act.upkeep.shown.secrets', from: 'action' },
  { key: 'act.upkeep.shown.policies', from: 'action' },
  { key: 'act.upkeep.shown.anchor', from: 'action' }
];

/** What is checked of the upkeep after the passkey. */
export const UPKEEP_CHECK: Words = Object.freeze({ key: 'act.upkeep.check.worked-out' });
