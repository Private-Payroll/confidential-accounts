/**
 * **THE DOORS A VAULT'S SECRET IS STARTED OR CHANGED ON, IN THE WALLET.** Every read the wallet's own or judged, every
 * write signed here with the seat's key: the vault's records, the secret kept in this wallet before its filing leaves,
 * the company's proposals and the readers of a vault's secret. Kept apart from the actions that use them, so the
 * upkeep can change a vault's secret on the same doors without loading any action.
 */
import { fromHex, type Hex } from '../../../../src/core/crypto.js';
import { rosterVaultKeys } from '../../../../src/core/vault-keys.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { rosterRefusalOf } from '../../../../src/midnight/secret-readers.js';
import type { SealedPool } from '../../../../src/midnight/vault-pool.js';
import { governedCallServiceThrough } from '../../../../packages/web-shared/src/governed-call-through-the-view.js';
import type { CreateVaultDoors, SecretKeptHere } from '../../../../packages/web-shared/src/vault-doors.js';
import type { VaultService } from '../../../../packages/web-shared/src/vault-service.js';
import type { RecordWrite, VaultStartStep } from '../../../../packages/web-shared/src/records-source.js';
import { vaultInfoRecordsFor } from '../../../../packages/web-shared/src/vault-info-here.js';
import { deviceRecordsFor, deviceSignerFrom, readersIn, seatNotBelievedHere } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { unnamedKeptIn } from '../../../../packages/web-shared/src/vault-notes-here.js';
import { readsJoinedIn } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { stopsFor } from './leaving-read-in-the-wallet.js';
import { vaultServiceThrough } from '../../../../packages/web-shared/src/vault-service-through-the-view.js';
import type { DeviceRecords } from '../../../../packages/web-shared/src/deposit-on-device.js';
import type { VaultAddress } from 'midnight-identity/profile/company-label';
import { vaultOnChain, fromIndexerAt } from '../chain/view-doors.js';
import { chainTimeOf } from './chain-time.js';
import { approversHere, runsOutrunHere } from './approvers-here.js';
import { enteredFor, writesOfTheStep, proposalsInTheView, type CompanyReach } from './company-reach.js';
import { StepRefused, type StepContext, type Words } from './definition.js';
import { adopted, CARRIED_BY } from './holders-moved-here.js';
import type { MovingSend } from './step-views.js';
import { signerMaterialOf } from '../../../../packages/web-shared/src/private-state.js';

/** Where a vault's secret is kept in this wallet, how the doors pause between reads, and the indexer they read vaults at. */
export interface VaultDoorsReach {
  readonly secrets: (person: string) => SecretKeptHere;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly indexerHttp: string;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.create-vault.why.${key}`, ...(values === undefined ? {} : { values }),
});

/**
 * Readers of the vault's secret: the records key each seat's directory entry names, for every seat this wallet believes
 * and the chain holds now (`readersIn`, the one rule every reader list is read by), refused unless the roster names a
 * signer for each seat the chain holds, signed for it by that signer's own wallet, and unless every seat the chain holds
 * is one of those readers, so no seated signer is left out.
 */
export const readersFrom = async (r: CompanyReach): Promise<Hex[]> => {
  const roster = await r.roster();
  const here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, async () => roster)();
  const holders = await r.holders();
  const keyed = rosterVaultKeys(roster);
  const refused = rosterRefusalOf({
    company: r.label, account: r.account, roster: keyed, seats: { seats: holders.seats }, directory: { seats: here.dir.seats, leafOf: here.leafOf },
  });
  if (refused !== null) throw new StepRefused(why('readers-refused', { says: refused.says }));
  const readers = await readersIn(async () => here).signers();
  for (const held of holders.seats.map((x) => x.toLowerCase())) {
    if (readers.some((x) => x.id === held)) continue;
    const entry = here.dir.seats.find((x) => x.seat === held);
    const reason = entry === undefined ? 'it has no entry in the company\'s directory that this wallet believes' : seatNotBelievedHere(here, entry);
    throw new StepRefused(why('readers-refused', {
      says: `the seat ${held} that the company's account holds is not one this wallet believes (${reason}), so the secret would not be `
        + 'sealed to it. Nothing was sealed; its signer opens the company in their own wallet, then try again.',
    }));
  }
  return readers.map((x) => x.wrappingPublicKey.toLowerCase() as Hex);
};

/** The records this seat files for the vault, the secret kept here before its filing leaves. */
export const recordsKeepingTheSecret = (records: DeviceRecords, kept: SecretKeptHere): DeviceRecords => (record) => {
  const inner = records(record);
  if (record !== 'nonce-secret') return inner;
  return new Proxy(inner, {
    get(target, p) {
      if (p === 'put') return async (vault: string, rec: SealedPool) => { await kept.keep(vault as Hex, rec); return target.put(vault, rec); };
      const v = Reflect.get(target, p);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
};

/**
 * The sends a vault's adoption may go by, declared as one move: the account's call of the vault's start written through
 * the view, or, when the service took nothing of it, the account's own adopt sent straight to the chain.
 */
export const adoptionSends = (account: string, vault: string): readonly MovingSend[] => [
  { start: vault }, { circuit: CARRIED_BY['adopt-vault'].circuit, contract: account.toLowerCase() },
];

/* What the service answered for one write through the step's view, refused as the service refused it. */
const writtenThrough = async <T>(r: CompanyReach, w: RecordWrite): Promise<T> => await writesOfTheStep(r)(r.accountId, w) as T;

/** The doors `createCompanyVault` runs on in the wallet: every read the wallet's own or judged, every write signed here. */
export function vaultDoorsFor(ctx: StepContext, r: CompanyReach, reach: VaultDoorsReach): CreateVaultDoors {
  const person = ctx.person ?? (() => { throw new StepRefused(why('no-person')); })();
  const kept = reach.secrets(person);
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const entered = enteredFor(r);
  type Started = Awaited<ReturnType<NonNullable<VaultService['startSecret']>>>;
  const started = (vault: string, step: VaultStartStep, body: unknown) => writtenThrough<Started>(r, { to: 'vault-start', vault, step, body });
  const base = vaultServiceThrough(r.stepView);
  const service: VaultService = {
    ...base,
    keys: async () => ({ committee: null, why: null, readers: await readersFrom(r) }),
    startAccountCall: (vault, body) => {
      if (body.call === 'adopt') ctx.movesWhoHolds(adoptionSends(r.account, vault), adopted(vault));
      return started(vault, 'account', body);
    },
    startSecret: (vault, tx) => started(vault, 'secret', { tx }),
    startCopy: (vault, tx, place) => started(vault, 'copy', { tx, place }),
  };
  const proposals = governedCallServiceThrough(r.stepView);
  const builder = {
    ...r.builder,
    bornHeldVault: async (input: Parameters<NonNullable<typeof r.builder.bornHeldVault>>[0]) => {
      const built = await r.builder.bornHeldVault!(input);
      ctx.tell({ vault: built.vault.toLowerCase() });
      return built;
    },
  } as typeof r.builder;
  return {
    sleep: (ms) => reach.pause(ms, ctx.signal),
    account: r.account,
    service,
    builder,
    ...(r.handOver === undefined ? {} : { handOver: r.handOver }),
    material: signerMaterialOf(r.seat),
    me: deviceSignerFrom(r.leaf, r.companyKey),
    myRecordsKey: recordsKeypairFrom(fromHex(r.companyKey)).publicKey as Hex,
    signers: readersIn(directory).signers,
    records: recordsKeepingTheSecret(deviceRecordsFor(r.seat.signingSecret, judge, readsJoinedIn(r.stepView, stopsFor(r))), kept),
    vaultInfo: vaultInfoRecordsFor(r.accountId, r.seat.signingSecret, judge, readsJoinedIn(r.stepView, stopsFor(r))),
    secretKeptHere: kept,
    ...unnamedKeptIn(r.stepView.current()),
    proposals: {
      accountId: r.accountId, directory, companyKeys: r.companyKeys, signingSecret: r.seat.signingSecret, entered,
      carried: (id, body) => writtenThrough(r, { to: 'carried', id, body }),
      service: {
        callState: proposals.callState,
        send: proposals.send, file: proposals.file!, sealedProposals: proposalsInTheView(r),
        ...(proposals.cancel === undefined ? {} : { cancel: proposals.cancel }),
      },
    },
    /* The chain's time, read at the wallet's own indexer, as a withdrawal reads it. */
    chainTime: chainTimeOf(r),
    onChain: async () => ({ holders: await r.holders() }),
    indexer: async () => r.chain.indexer,
    vaultsHere: r.vaultsHere,
    secretReaders: {
      company: r.label,
      read: async (vault) => {
        const holders = await r.holders();
        const v = await vaultOnChain(vault as unknown as VaultAddress, fromIndexerAt(reach.indexerHttp));
        return { seats: holders.seats, vault: v.of === 'read' ? v.holders : null } as never;
      },
      roster: async () => rosterVaultKeys(await r.roster()),
      directory: async () => {
        const here = await directory();
        const readers = (await readersIn(async () => here).signers()).map((x) => x.wrappingPublicKey.toLowerCase());
        return { seats: here.dir.seats, leafOf: here.leafOf, readers };
      },
    },
    approvers: () => approversHere(r, () => runsOutrunHere(r)),
    vaultName: (vault) => vault,
  };
}
