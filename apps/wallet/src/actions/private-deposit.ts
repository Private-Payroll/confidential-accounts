import type { Identity } from 'midnight-identity/keys/derivation';
import type { ActIntent } from 'midnight-identity/profile/request';
import { readVaultAddress, type VaultAddress } from 'midnight-identity/profile/company-label';
import { fromHex, type Hex } from '../../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import type { DepositMoney } from '../../../../src/midnight/deposit-nonce.js';
import {
  depositIntoCompanyVault, DepositLandedNotYetRecorded, DepositNotYetSeen, type DepositDoors, type DepositsInFlight, type VaultService,
} from '../../../../packages/web-shared/src/vault-operation.js';
import {
  browserDepositsInFlight, browserInFlightRecords, deviceRecordsFor, deviceSignerFrom, readersIn, vaultServiceFor,
} from '../../../../packages/web-shared/src/vault-page-doors.js';
import { coinsKeptOnThisDevice, type CoinsKeptHere } from '../../../../packages/web-shared/src/vault-coins-kept-here.js';
import type { InFlightOpener } from '../../../../packages/web-shared/src/in-flight-on-this-device.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { payForThePage, readWhatThePageAsks, type BalanceDoors } from '../chain/balance-for-page.js';
import { companyReachFor, enteredFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';

/*
 * A PRIVATE DEPOSIT, MADE WHOLE IN THE WALLET.
 *
 * The page names the company, the vault, the private token and the amount; the wallet does the rest from its own reads
 * and the saved keys the page handed it sealed. It finds its seat on the chain (`companyReachFor`), reads the vault at
 * its own indexer and checks it is the company's and takes money, records an earlier deposit of its own that landed,
 * files the vault's secret again where the chain's is not the newest filed, claims the coin (its line in the deposit
 * journal), builds and proves the deposit in its own vault builder, keeps the deposit on its way in its own storage,
 * pays it from the account the person chose, hands the one transaction to the page to send, waits for the chain to
 * show it, and files the vault's pool with it. Every record is signed with the seat's key here and filed through the
 * page, each with its signed entry in the company's record manifest. The page's answers are its word: a send the page
 * says it did not make is still a deposit on its way, so the wallet builds no other into this vault until the chain
 * shows it or its time to live has passed. Between the seat and the deposit, the action does what the company is owed
 * of this seat (its owed directory entry, its key changed, its roster followed); after the deposit it files each vault's
 * records again for the signers seated since and anchors what was filed (`upkeepSteps`).
 */

/** What a private deposit reaches beyond the action: the chain and the builder the wallet reads and proves with, its clock, and how it pays. */
export interface PrivateDepositReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly now: () => number;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The wallet's own balancing for the person's account `account`: the coins it pays the deposit from. */
  readonly balance: (identity: Identity, account: number) => BalanceDoors & { readonly stop?: () => Promise<void> };
  /** Where the wallet keeps a deposit on its way and the coins it made, for the seat `opener`: its own storage, never the page's. */
  readonly kept?: (opener: InFlightOpener) => { readonly inFlight: DepositsInFlight; readonly coins?: CoinsKeptHere };
  /** The company and this seat as the wallet reads them; `companyReachFor` unless a test stands it in. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.private-deposit.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** Where the deposit got to, as the action's outcome tells the page. */
const STATE = {
  recorded: 'recorded', notYetSpendable: 'not-yet-spendable', notYetSeen: 'not-yet-seen', landedNotRecorded: 'landed-not-recorded',
} as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const bare = (h: string): string => h.toLowerCase().replace(/^0x/u, '');
/** The service's name for a sent deposit, kept only when it is a short plain name: anything else is kept as none. */
const PLAIN_REF = /^[A-Za-z0-9._:-]{1,128}$/u;

/** The wallet's own storage for a deposit on its way and the coins it made: this origin's, which no page can reach. */
const keptInTheWallet = (opener: InFlightOpener) => ({
  inFlight: browserDepositsInFlight(opener),
  coins: coinsKeptOnThisDevice(browserInFlightRecords(), opener),
});

/** The money the action names: the private token and the amount, as the ask's fields carry them. */
export const moneyOf = (intent: ActIntent): DepositMoney | null => {
  const token = intent.fields['token'];
  const amount = intent.fields['amount'];
  if (token === undefined || !HEX64.test(token) || amount === undefined || !/^[1-9][0-9]*$/u.test(amount)) return null;
  return { token: token as Hex, value: BigInt(amount) };
};

/**
 * **WHAT THE SHARED DEPOSIT STEP IS GIVEN IN THE WALLET**: the wallet's own reads of the chain and the vault builder,
 * the company's records filed and believed under this seat, the deposit on its way kept in the wallet's own storage,
 * a payment made only for the coin of `money` into `vault`, and a send whose failure the page cannot turn into
 * "nothing was sent".
 */
export function depositDoorsFor(
  ctx: StepContext, r: CompanyReach, reach: PrivateDepositReach, vault: VaultAddress, money: DepositMoney,
): DepositDoors {
  const person = ctx.person ?? (() => { throw new StepRefused(why('no-person')); })();
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  const opener = { signerId: me.signerId, wrappingSecret: me.wrappingSecret };
  const kept = (reach.kept ?? keptInTheWallet)(opener);
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const base = vaultServiceFor(r.api, r.accountId, r.roster);
  const service: VaultService = {
    ...base,
    keys: async () => { throw new Error('a private deposit reads no readers from the service.'); },
    deposit: async (v, tx) => {
      let answer: { txRef?: unknown; transactionHash?: unknown } | null;
      try {
        answer = await r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/vaults/${v}/deposit`, { method: 'POST', body: JSON.stringify({ tx }) });
      } catch (e) {
        /* The page holds the finished deposit: its word that nothing was sent is never believed, so the deposit stays on its way. */
        throw new Error(`the page did not confirm it sent the deposit (${(e as Error)?.message ?? String(e)}); it may still be sent.`);
      }
      const ref = typeof answer?.txRef === 'string' && PLAIN_REF.test(answer.txRef) ? answer.txRef : '';
      const hash = typeof answer?.transactionHash === 'string' && HEX64.test(bare(answer.transactionHash)) ? bare(answer.transactionHash) : null;
      return { txRef: ref, transactionHash: hash };
    },
  };
  const account = ctx.held.account;
  return {
    sleep: (ms) => reach.pause(ms, ctx.signal),
    clock: reach.now,
    service,
    company: r.label,
    account: r.account,
    builder: r.builder,
    onChain: async () => ({ holders: await r.holders() }),
    indexer: async () => r.chain.indexer,
    me,
    myRecordsKey: recordsKeypairFrom(fromHex(r.companyKey)).publicKey as Hex,
    signers: readersIn(directory).signers,
    records: deviceRecordsFor(r.seat.signingSecret, judge, () => person, enteredFor(r), r.send),
    inFlight: kept.inFlight,
    ...(kept.coins === undefined ? {} : { kept: kept.coins }),
    pay: async (ask) => {
      if (ask.company !== r.label || ask.account !== r.account || ask.vault.toLowerCase() !== vault) {
        throw new StepRefused(why('not-as-built'));
      }
      if (account === undefined) throw new StepRefused(why('no-account'));
      const doors = reach.balance(ctx.held.identity, account);
      try {
        const read = readWhatThePageAsks(await doors.ledger(), ask.transaction, vault);
        const leaf = read.leaves[0];
        /* Paid only for the one coin this wallet built: of the amount and the token the window showed, into this vault. */
        if (read.pays !== 'private' || read.leaves.length !== 1 || leaf === undefined || leaf.kind !== 'shielded'
          || bare(leaf.token) !== bare(money.token) || BigInt(leaf.amount) !== money.value) {
          throw new StepRefused(why('not-as-built'));
        }
        const finished = await payForThePage(doors, read.tx, { pays: 'private', leaves: read.leaves }, { stillWanted: () => !ctx.signal.aborted });
        return { transaction: finished, leaves: read.leaves };
      } finally {
        await doors.stop?.().catch(() => undefined);
      }
    },
  };
}

/** The one private deposit an act asks for, run whole in the wallet. */
export function privateDepositAction(reach: PrivateDepositReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.private-deposit.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.private-deposit.shown.amount', values: { amount: intent.fields['amount'] ?? '', token: intent.fields['token'] ?? '' }, from: 'page' as const },
      { key: 'act.private-deposit.shown.pays', from: 'action' as const },
      { key: 'act.private-deposit.shown.vault', values: { vault: intent.fields['vault'] ?? '' }, from: 'page' as const },
      { key: 'act.private-deposit.shown.vault-check', from: 'action' as const },
      { key: 'act.private-deposit.shown.records', from: 'action' as const },
      { key: 'act.private-deposit.shown.journal', from: 'action' as const },
      { key: 'act.private-deposit.shown.pool', from: 'action' as const },
      { key: 'act.private-deposit.shown.earlier', from: 'action' as const },
      { key: 'act.private-deposit.shown.secret-again', from: 'action' as const },
      { key: 'act.private-deposit.shown.manifest', from: 'action' as const },
      ...upkeepShown({ ownEntry: true }),
      { key: 'act.private-deposit.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.private-deposit.check.seat' },
      { key: 'act.private-deposit.check.vault' },
      { key: 'act.private-deposit.check.secret' },
      { key: 'act.private-deposit.check.built' },
      { key: 'act.private-deposit.check.one-on-its-way' },
      UPKEEP_CHECK,
    ],
    check: async (intent, held) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      if (readVaultAddress(intent.fields['vault']) === null) return why('not-a-vault');
      if (moneyOf(intent) === null) return why('nothing');
      if (held.account === undefined) return why('no-account');
      return null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.private-deposit.step.seat' },
        run: async (ctx) => {
          await read.at(ctx);
        },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, { coins: (opener) => (reach.kept ?? keptInTheWallet)(opener).coins }, { ownEntry: true });
      const deposit: ActionStep = {
        title: { key: 'act.private-deposit.step.deposit' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const vault = readVaultAddress(intent.fields['vault']) ?? (() => { throw new StepRefused(why('not-a-vault')); })();
          const money = moneyOf(intent) ?? (() => { throw new StepRefused(why('nothing')); })();
          ctx.tell({ vault });
          try {
            const done = await depositIntoCompanyVault(depositDoorsFor(ctx, r, reach, vault, money), vault as unknown as Hex, money);
            const created = typeof done.note.createdIn === 'string' && HEX64.test(bare(done.note.createdIn)) ? bare(done.note.createdIn) : null;
            ctx.tell({ state: done.notYetSpendable === undefined ? STATE.recorded : STATE.notYetSpendable, ...(created === null ? {} : { created }) });
          } catch (e) {
            if (e instanceof ActionStopped || e instanceof StepRefused) throw e;
            if (e instanceof DepositNotYetSeen) {
              ctx.tell({ state: STATE.notYetSeen });
              throw new StepRefused(why('not-yet-seen'));
            }
            if (e instanceof DepositLandedNotYetRecorded) {
              ctx.tell({ state: STATE.landedNotRecorded });
              throw new StepRefused(why('landed-not-recorded'));
            }
            throw new StepRefused(why('not-made', { says: (e as Error)?.message ?? String(e) }));
          }
        },
      };
      return [seat, upkeep.first, deposit, upkeep.last];
    },
  } satisfies ActionDefinition);
}
