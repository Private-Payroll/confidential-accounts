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
import { governedCallServiceFor } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { CreateVaultDoors, SecretKeptHere, VaultService } from '../../../../packages/web-shared/src/vault-operation.js';
import { vaultInfoRecordsFor } from '../../../../packages/web-shared/src/vault-info-here.js';
import { deviceRecordsFor, deviceSignerFrom, readersIn, seatNotBelievedHere, vaultServiceFor } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { DeviceRecords } from '../../../../packages/web-shared/src/deposit-on-device.js';
import type { VaultAddress } from 'midnight-identity/profile/company-label';
import { vaultOnChain, fromIndexerAt } from '../chain/company-label-on-chain.js';
import { chainTimeOf } from './chain-time.js';
import { approversHere, enteredFor, runsOutrunHere, type CompanyReach } from './company-reach.js';
import { StepRefused, type StepContext, type Words } from './definition.js';

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

/** The doors `createCompanyVault` runs on in the wallet: every read the wallet's own or judged, every write signed here. */
export function vaultDoorsFor(ctx: StepContext, r: CompanyReach, reach: VaultDoorsReach): CreateVaultDoors {
  const person = ctx.person ?? (() => { throw new StepRefused(why('no-person')); })();
  const kept = reach.secrets(person);
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const entered = enteredFor(r);
  const at = (vault: string, route: string) => `/api/accounts/${encodeURIComponent(r.accountId)}/vaults/${vault}${route}`;
  const post = (path: string, body: unknown) => r.api(path, { method: 'POST', body: JSON.stringify(body) });
  const base = vaultServiceFor(r.api, r.accountId, r.roster);
  const service: VaultService = {
    ...base,
    keys: async () => ({ committee: null, why: null, readers: await readersFrom(r) }),
    startAccountCall: (vault, body) => post(at(vault, '/start/account'), body),
    startSecret: (vault, tx) => post(at(vault, '/start/secret'), { tx }),
    startCopy: (vault, tx, place) => post(at(vault, '/start/copy'), { tx, place }),
  };
  const proposals = governedCallServiceFor(r.api);
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
    material: { signingSecret: r.seat.signingSecret, blinding: r.seat.blinding, scope: r.seat.scope },
    me: deviceSignerFrom(r.leaf, r.companyKey),
    myRecordsKey: recordsKeypairFrom(fromHex(r.companyKey)).publicKey as Hex,
    signers: readersIn(directory).signers,
    records: recordsKeepingTheSecret(deviceRecordsFor(r.seat.signingSecret, judge, () => person, entered, r.send), kept),
    vaultInfo: vaultInfoRecordsFor(r.accountId, r.seat.signingSecret, judge, () => person, r.send),
    secretKeptHere: kept,
    proposals: {
      accountId: r.accountId, directory, companyKeys: r.companyKeys, signingSecret: r.seat.signingSecret, entered,
      carried: (id, body) => post(`/api/proposals/${encodeURIComponent(id)}/carried`, body),
      service: {
        callState: async () => {
          const chain = await r.chain.callState(r.account);
          if (chain === null) throw new Error('this wallet could not read the company\'s account at one block.');
          return { ...chain, account: r.account };
        },
        send: proposals.send, file: proposals.file!, sealedProposals: proposals.sealedProposals!,
        ...(proposals.cancel === undefined ? {} : { cancel: proposals.cancel }),
      },
    },
    /* The chain's time, read at the wallet's own indexer, as a withdrawal reads it. */
    chainTime: chainTimeOf(r),
    onChain: async () => ({ holders: await r.holders() }),
    indexer: async () => r.chain.indexer,
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
