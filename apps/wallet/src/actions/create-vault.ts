import { fromHex, type Hex } from '../../../../src/core/crypto.js';
import { rosterVaultKeys } from '../../../../src/core/vault-keys.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { rosterRefusalOf } from '../../../../src/midnight/secret-readers.js';
import type { SealedPool } from '../../../../src/midnight/vault-pool.js';
import { governedCallServiceFor } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import {
  createCompanyVault, NOT_BUILT, START_READ_STOP, START_STOP, VaultNotBuilt, VaultNotTheCompanys, VaultStartOwed,
  type CreateVaultDoors, type SecretKeptHere, type VaultService,
} from '../../../../packages/web-shared/src/vault-operation.js';
import { VaultInfoRefused, vaultInfoRecordsFor } from '../../../../packages/web-shared/src/vault-info-here.js';
import { deviceRecordsFor, deviceSignerFrom, readersIn, vaultServiceFor } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { DeviceRecords } from '../../../../packages/web-shared/src/deposit-on-device.js';
import { readAccountAddress, readCompanyLabel, readVaultAddress, type VaultAddress } from 'midnight-identity/profile/company-label';
import { vaultOnChain, fromIndexerAt } from '../chain/company-label-on-chain.js';
import { approversHere, enteredFor, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type StepContext, type Words } from './definition.js';
import { vaultKeysShown, vaultKeysSteps, type VaultKeysReach } from './give-vault-keys.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * CREATE A VAULT, IN THE WALLET, AS ONE ACTION. It gives this seat's vault keys
 * first, then builds the vault born held by the company's committee, proves
 * and signs every step of its start here - its name, its adoption, its pool,
 * its first secret and each signer's sealed copy - and hands each to the page
 * to send. The vault's secret is made here, kept in this wallet's own store
 * before the company's records are asked to file it, and sealed only to the
 * seats the wallet read on the chain, each one's records key signed by that
 * seat's own wallet and believed in the company's directory; a seat it cannot
 * believe stops the action before anything is approved. Before any of it, the
 * action does what the company is owed of this seat (its key changed, its
 * roster followed); after it, it files each vault's records again for the
 * signers seated since and anchors what was filed (`upkeepSteps`).
 */

/** Where the action keeps a new vault's secret, and how it pauses between reads of the chain. */
export interface CreateVaultReach extends VaultKeysReach {
  readonly secrets: (person: string) => SecretKeptHere;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly indexerHttp: string;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.create-vault.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** The kinds of stop a refused start names to the page with its words' key: the start's own, its reads' and a vault not built. */
const NAMED_TO_THE_PAGE = new Set<string>([...Object.values(START_STOP), ...Object.values(START_READ_STOP), ...Object.values(NOT_BUILT)]);
export const namedCode = (code: string | undefined): string | undefined => (code !== undefined && NAMED_TO_THE_PAGE.has(code) ? code : undefined);

/**
 * The step's refusal for what stopped the vault's creation or start, with the kind of stop the page may be told, and
 * the vault told when one was sent; null for anything else, which the step throws as it came.
 */
export const startRefusalOf = (e: unknown, ctx: Pick<StepContext, 'tell'>): StepRefused | null => {
  if (e instanceof VaultStartOwed) {
    ctx.tell({ vault: String(e.vault).toLowerCase(), ...(e.stoppedAt === undefined ? {} : { stopped: e.stoppedAt }) });
    return new StepRefused(why('start-owed', { says: e.message }), namedCode(e.stoppedAt));
  }
  if (e instanceof VaultNotBuilt) return new StepRefused(why('not-built', { code: e.code, says: e.message }), namedCode(e.code));
  if (e instanceof VaultNotTheCompanys) return new StepRefused(why('not-the-companys', { says: e.message }));
  if (e instanceof VaultInfoRefused) return new StepRefused(why('name-refused', { says: e.message }));
  return null;
};

/** Readers of the vault's secret: every signer's records key from the roster this wallet believes, refused unless each seat the chain holds is one of them. */
export const readersFrom = async (r: CompanyReach): Promise<Hex[]> => {
  const roster = await r.roster();
  const here = await r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, async () => roster)();
  const holders = await r.holders();
  const keyed = rosterVaultKeys(roster);
  const refused = rosterRefusalOf({
    company: r.label, account: r.account, roster: keyed, seats: { seats: holders.seats }, directory: { seats: here.dir.seats, leafOf: here.leafOf },
  });
  if (refused !== null) throw new StepRefused(why('readers-refused', { says: refused.says }));
  return keyed.map((e) => e.keys!.recordsKey.toLowerCase() as Hex);
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
export function vaultDoorsFor(ctx: StepContext, r: CompanyReach, reach: CreateVaultReach): CreateVaultDoors {
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
      },
    },
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
        return { seats: here.dir.seats, leafOf: here.leafOf };
      },
    },
    approvers: () => approversHere(r),
    vaultName: (vault) => vault,
  };
}

/** Create a vault: the seat's vault keys given first, then the vault built, started and its secret set, in one action. */
export function createVaultAction(reach: CreateVaultReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.create-vault.headline',
    shown: async (intent) => {
      const named = intent.fields['vault'];
      const readers = intent.fields['readers'];
      /* Read before the passkey from this wallet's own indexer, which needs no seed: how many seats the secret is sealed to. */
      const label = readCompanyLabel(intent.fields['company']);
      const account = readAccountAddress(intent.fields['account']);
      const seated = label === null || account === null ? null
        : await reach.chain().holders(account, label).then((h) => ('key' in h ? null : h.seats.length), () => null);
      return [
        ...vaultKeysShown(intent, 'act.create-vault'),
        ...(named === undefined
          ? [{ key: 'act.create-vault.shown.new', from: 'action' as const }]
          : [
            { key: 'act.create-vault.shown.carry-on', values: { vault: named }, from: 'page' as const },
            { key: 'act.create-vault.shown.carry-on-check', from: 'action' as const },
          ]),
        ...(intent.fields['title'] === undefined ? [] : [{ key: 'act.create-vault.shown.title', values: { title: intent.fields['title']! }, from: 'page' as const }]),
        ...(intent.fields['about'] === undefined ? [] : [{ key: 'act.create-vault.shown.about', values: { about: intent.fields['about']! }, from: 'page' as const }]),
        seated === null
          ? { key: 'act.create-vault.shown.sealed-to-unread', from: 'action' as const }
          : { key: 'act.create-vault.shown.sealed-to', values: { seats: seated }, from: 'wallet' as const },
        ...(readers === undefined ? [] : [{ key: 'act.create-vault.shown.readers', values: { names: readers }, from: 'page' as const }]),
        ...upkeepShown(),
        { key: 'act.create-vault.shown.nothing-else', from: 'action' as const },
      ];
    },
    checks: [
      { key: 'act.create-vault.check.seat' },
      { key: 'act.create-vault.check.readers' },
      { key: 'act.create-vault.check.born-held' },
      { key: 'act.create-vault.check.made-here' },
      UPKEEP_CHECK,
    ],
    check: async (intent, held) => {
      if (held.wallet === undefined) return why('no-record');
      if (intent.fields['record'] === undefined) return why('not-a-company');
      if (intent.fields['vault'] !== undefined && readVaultAddress(intent.fields['vault']) === null) return why('not-a-vault');
      return null;
    },
    steps: (intent) => {
      const keys = vaultKeysSteps(reach, why, 'act.create-vault');
      const start: ActionStep = {
        title: { key: 'act.create-vault.step.start' },
        run: async (ctx) => {
          const { reach: r } = await keys.given(ctx);
          const vault = intent.fields['vault'];
          if (vault !== undefined) ctx.tell({ vault: vault.toLowerCase() });
          /* A new vault is built only once every seat the chain holds can be given its secret, so none is left half set up for want of a signer's keys. */
          if (vault === undefined) await readersFrom(r);
          const title = intent.fields['title'];
          const info = title === undefined ? undefined : { name: title, description: intent.fields['about'] ?? '' };
          try {
            const done = await createCompanyVault(vaultDoorsFor(ctx, r, reach), vault as Hex | undefined, info);
            ctx.tell({ vault: done.vault.toLowerCase(), ...(done.saidCodes === undefined || done.saidCodes.length === 0 ? {} : { said: done.saidCodes.join(',') }) });
            if (done.state === 'awaiting-approvals') {
              ctx.tell({ round: done.awaiting.round, approvals: done.awaiting.approvals, needed: done.awaiting.needed });
            }
          } catch (e) {
            throw startRefusalOf(e, ctx) ?? e;
          }
        },
      };
      const upkeep = upkeepSteps({ reach: keys.company, renew: keys.renew }, reach);
      return [upkeep.first, ...keys.steps, start, upkeep.last];
    },
  } satisfies ActionDefinition);
}
