/**
 * **A COMPANY'S VAULTS, AS ITS SIGNERS' DEVICES CREATE, HAND OVER AND FUND
 * THEM.**
 *
 * Nothing a device sends here carries a secret: the device builds and proves a
 * vault's transactions; the depositor's own wallet puts in and signs for any
 * coin; this service reads what arrives, refuses anything that is not exactly
 * what the route is for, and pays only the network fee. **The one transaction
 * this service builds and signs itself is a company account's handover**, with
 * the temporary key it deployed the account under, and it reads that one as it
 * reads a stranger's before paying for it. What it answers about a vault's rules is read from
 * the chain each time it is asked.
 *
 *   PUT  /api/accounts/:id/vault-keys                   a signer's three public vault keys
 *   GET  /api/accounts/:id/vault-keys                   the committee, and who can read the records
 *   GET  /api/accounts/:id/vaults                       the company's vaults, and who holds each on chain
 *   POST /api/accounts/:id/vaults                       a vault deployed with a temporary key
 *   POST /api/accounts/:id/vaults/:vault/handover       that vault handed to the company's committee
 *   GET  /api/accounts/:id/vaults/:vault/chain          what the chain holds for one vault
 *   POST /api/accounts/:id/vaults/:vault/deposit        a deposit the depositor's wallet has paid for
 *   GET  /api/accounts/:id/vaults/:vault/payout-state   the chain as one block saw it, for a payout to be built on
 *   GET  /api/accounts/:id/vaults/:vault/events/:tx     what one transaction created, for a note's place to be read
 *   POST /api/accounts/:id/vaults/:vault/payout         a private payment out of the vault
 *   GET  /api/accounts/:id/authority                    who holds the account's and every vault's rules
 *   GET  /api/accounts/:id/call-state                   the account as one block saw it, for a raise or an approval to be built on
 *   POST /api/accounts/:id/authority/handover           the company account handed to the committee
 *
 * **AND THESE ROUTES CARRY NO MONEY INTO ANY VAULT UNTIL THE CHAIN SHOWS THE
 * COMPANY ACCOUNT HELD BY THE COMMITTEE TOO.** A vault pays out on its
 * account's approval, so whoever holds the account's rules decides every
 * vault's payouts, whoever holds the vault's. What these routes cannot stop:
 * anybody paying their own fee can call a vault's deposit directly.
 *
 * **A VAULT IS NEVER REPORTED CREATED UNTIL THE CHAIN SAYS ITS COMMITTEE HOLDS
 * IT.** A deploy whose handover has not landed is reported as a handover owed,
 * naming the vault, and no deposit into it is carried.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount, CompanyVault, VaultKeysOfASigner } from '../core/types.js';
import type { Ledger, VaultTxArrival } from '../core/ledger.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { readContractAuthority, type AuthorityRead } from '../midnight/ledger.js';
import { committeeOf, sameCommittee, whyNoCommittee, type Committee } from '../midnight/vault-committee.js';
import { authorityView, everySignerNeeded, type ContractAuthorityView } from '../midnight/company-authority.js';
import {
  circuitsRefusal, asFarAsTheVault, readVaultDeploy, refusalForDeposit, refusalForHandover, refusalForPayout, refusalForPublicPayout,
  refusalToPutMoneyIn, type FundingFacts, type VaultStartingLedger,
} from '../wiring/vault-submission.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const fold = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');

/** A proven transaction on this wire: base64, and never more than the product's proven limit. */
export const VAULT_TX_LIMIT = 1_000_000;

/** What these routes read about one vault from the chain. */
export interface VaultChain {
  /** The vault's contract state as the indexer serves it, or null when there is none. */
  contractState(vault: Hex): Promise<unknown | null>;
  /** The state's bytes, as a device reads them back. */
  serialize(state: unknown): Uint8Array;
  /** The vault's note commitments now, lower-case hex. */
  notesOf(state: unknown): readonly Hex[];
  /**
   * **RETURNS ONLY WHEN THE STATE IS A LEDGER OF THE SHAPE THIS BUILD'S VAULT
   * HAS**, and refuses, saying how it differs, when it is not. A field is read
   * off a ledger by its position, so a vault of another shape answers the
   * question about its notes out of whichever field is in that place. Absent
   * where this deployment cannot tell, and then the notes are not vouched for.
   */
  ledgerIsThisBuilds?(state: unknown): Promise<void>;
  /** What the vault's ledger holds, read through the vault's own compiled ledger. */
  startingLedgerOf(state: unknown): VaultStartingLedger;
  /** Every output the chain has ever created for the vault. */
  everCreated(vault: Hex): Promise<ReadonlySet<string>>;
  /**
   * **ONE BLOCK'S VIEW OF EVERYTHING A PRIVATE PAYMENT IS BUILT ON**: the vault's
   * state, the chain's commitment tree and parameters as that block holds them,
   * and the account's state at the same block, which the vault's call reads.
   * Each value is its bytes. Absent where this deployment reads no chain.
   */
  payoutState?(vault: Hex, account: Hex): Promise<PayoutState | null>;
  /**
   * **ONE BLOCK'S VIEW OF THE COMPANY ACCOUNT, FOR A PROPOSAL TO BE RAISED OR
   * APPROVED ON**: the account's state and the ledger parameters as that block
   * holds them. Each value is its bytes. Absent where this deployment reads no
   * chain.
   */
  accountCallState?(account: Hex): Promise<AccountCallState | null>;
  /**
   * **WHAT ONE TRANSACTION CREATED**, as the chain's own events say: the only
   * place a note's position in the commitment tree is read from.
   */
  eventsOf?(transactionHash: Hex): Promise<readonly ServedEventOnTheWire[]>;
}

/** The chain as one block saw it, for a private payment to be built on. Every value is the bytes, as base64. */
export interface PayoutState {
  readonly blockHash: string;
  readonly vaultState: string;
  readonly zswapState: string;
  readonly parameters: string;
  readonly accountState: string;
}

/** The company account as one block saw it, for a governed call to be built on. Base64 of the bytes. */
export interface AccountCallState {
  readonly blockHash: string;
  readonly accountState: string;
  readonly parameters: string;
}

/** One zswap event of one transaction, with its position as a decimal string. */
export interface ServedEventOnTheWire {
  readonly transactionHash: string;
  readonly details: { readonly tag: string; readonly commitment?: string; readonly contract?: string; readonly mtIndex?: string };
}

export interface CompanyVaultDeps {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: {
    getAccount(id: string): SealedAccount | null;
    putCompanyVault(v: CompanyVault): void;
    getCompanyVault(vault: string): CompanyVault | null;
    listCompanyVaults(accountId: string): CompanyVault[];
    putVaultKeys(k: VaultKeysOfASigner): void;
    getVaultKeys(accountId: string, userId: string): VaultKeysOfASigner | null;
  };
  /** The company's account contract address, and its approval threshold, as the chain holds them. */
  readonly company: (accountId: string) => Promise<{ address: Hex; threshold: number } | null>;
  readonly ledger: Pick<Ledger, 'sendVault'>;
  readonly chain: VaultChain;
  /** Every vault circuit's verifying key, as this build compiled it. */
  readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
  /** The company account's deployed circuits and their verifying keys, as this build compiled them. */
  readonly account: {
    readonly circuits: readonly string[];
    readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
    /**
     * Builds and proves the account's handover, signed by this service's
     * temporary key. Absent when this deployment keeps no such key, and then
     * the handover is refused by name.
     */
    readonly handover?: (input: { read: AuthorityRead; to: Committee }) => Promise<Uint8Array>;
    /** The public half of that temporary key, so a seat it holds is named as this service's. */
    readonly temporaryKey?: { tag: string; value: string };
  };
  readonly readers: { proven(bytes: Uint8Array): Promise<unknown>; finished(bytes: Uint8Array): Promise<unknown> };
  readonly now?: () => Date;
}

/** The committee a company's vault must be held by, from the signers who have given keys. */
export function companyCommittee(
  account: SealedAccount, threshold: number,
  keysOf: (userId: string) => VaultKeysOfASigner | null,
): { committee: Committee | null; why: string | null } {
  const keys = account.memberUserIds.map((u) => keysOf(u)?.committeeKey ?? null);
  const why = whyNoCommittee({ keys, threshold, signerCount: account.signerCount });
  return why === null
    ? { committee: committeeOf(keys, threshold, account.signerCount), why: null }
    : { committee: null, why };
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * **ONE WORD FOR WHERE A VAULT STANDS, FROM WHAT THE CHAIN SAID AND WHY MONEY
 * MAY NOT GO IN.** `handover-owed` only when the vault is exactly as it was
 * deployed - one key, never changed - because that is the only state the
 * "finish" button can move. A vault held by any other set of keys, including a
 * committee the company had before a signer joined or left, is
 * `held-by-other-keys`: nothing on this screen can finish that, and saying
 * otherwise would send a person to press a button the service will refuse.
 */
export type AccountNotReady = 'not-handed-over' | 'not-vouched' | 'unknown';

export function vaultState(
  read: AuthorityRead,
  refused: { heldByOthers: boolean; accountNotReady?: AccountNotReady } | null,
): string {
  if (refused === null) return 'held-by-committee';
  /* An account still exactly as deployed is a step somebody has not taken yet; any other refusal about the
   * account - other keys, more than one change, circuits this build did not compile - is an alarm. */
  if (refused.accountNotReady === 'not-handed-over') return 'account-not-handed-over';
  if (refused.accountNotReady === 'not-vouched') return 'account-not-fundable';
  if (refused.accountNotReady === 'unknown') return 'unknown';
  /*
   * **WHAT THE CHAIN SAID IS READ HERE AND NOT INFERRED FROM THE REFUSAL.** A
   * vault the chain could not be asked about is not a vault this service has
   * decided something about, whatever else the refusal carries.
   */
  if (read.state !== 'read') return read.state === 'absent' ? 'not-on-chain-yet' : 'unknown';
  if (!refused.heldByOthers) return 'not-fundable';
  return read.authority.shape === 'one-key' && read.authority.counter === 0n ? 'handover-owed' : 'held-by-other-keys';
}

/** The signed-in person, as the sign-in in front of these routes set them. */
const personOf = (req: express.Request): string => (req as { userId?: string }).userId!;

export function companyVaultRoutes(deps: CompanyVaultDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? (() => new Date());
  const guard = [deps.signedIn, express.json({ limit: '4mb' }), deps.member];

  const accountOf = (req: express.Request): SealedAccount => {
    const a = deps.store.getAccount(String(req.params.id));
    if (!a) throw new Error('account not found');
    return a;
  };

  const committeeNow = async (account: SealedAccount) => {
    const company = await deps.company(account.id);
    if (company === null) {
      return { company: null, committee: null, why: 'this company has no contract on the chain this service can read, so it has no vaults yet.' };
    }
    const found = companyCommittee(account, company.threshold, (u) => deps.store.getVaultKeys(account.id, u));
    return { company, ...found };
  };

  const theVault = (req: express.Request, res: express.Response): CompanyVault | null => {
    const vault = fold(String(req.params.vault));
    const record = HEX64.test(vault) ? deps.store.getCompanyVault(vault) : null;
    if (!record || record.accountId !== String(req.params.id)) {
      res.status(404).json({ nothingWasSent: true, error: 'this company has no vault at that address.' });
      return null;
    }
    return record;
  };

  const authorityOf = (vault: Hex): Promise<AuthorityRead> =>
    readContractAuthority((a) => deps.chain.contractState(a as Hex), vault);

  /*
   * **WHAT THE CHAIN SAYS ABOUT THE COMPANY'S ACCOUNT RIGHT NOW.** Its
   * authority and its circuits, each read afresh and never from a record kept
   * here. Read once per request and handed to every vault the request answers
   * for, because the account is the same account for all of them.
   */
  const accountFactsOf = async (
    companyAddress: Hex,
  ): Promise<{ read: AuthorityRead; circuits: string | null }> => {
    const read = await authorityOf(companyAddress);
    let state: unknown;
    try {
      state = await deps.chain.contractState(companyAddress);
    } catch (e) {
      return {
        read: { state: 'unreachable', address: companyAddress, why: (e as Error)?.message ?? String(e) },
        circuits: null,
      };
    }
    return {
      read,
      circuits: circuitsRefusal(
        state, await deps.account.verifierKeys(),
        'no money goes in, because this company\'s account is not the one this service\'s build compiled',
        deps.account.circuits, 'the account\'s'),
    };
  };

  /*
   * **WHETHER MONEY MAY GO INTO THIS VAULT.** Every fact is read from the chain
   * here and the answer itself is `refusalToPutMoneyIn`, which is the same
   * function the operator tools ask. This route reads; it does not decide.
   */
  const whyNotFunded = async (
    vault: Hex, read: AuthorityRead, committee: Committee, companyAddress: string, state?: unknown,
    accountFacts?: { read: AuthorityRead; circuits: string | null },
    what = 'no money goes into this vault',
    /* The narrower question a device's handover waits on: the vault alone, never a door carrying money. */
    asFar: typeof refusalToPutMoneyIn = refusalToPutMoneyIn,
  ): Promise<{ why: string; heldByOthers: boolean; accountNotReady?: AccountNotReady; vaultRead: AuthorityRead } | null> => {
    let now = state;
    let vaultRead = read;
    if (now === undefined) {
      try {
        now = await deps.chain.contractState(vault);
      } catch (e) {
        /*
         * **A READ THAT WENT UNANSWERED IS A FACT THE GATE IS GIVEN, NOT A
         * REFUSAL WRITTEN HERE.** The rules read a moment ago are not what the
         * chain says now, so the vault is put to the gate as a chain that could
         * not be asked, and the caller is handed that read back: a screen then
         * shows a question that could not be answered, not an alarm about the
         * vault.
         */
        vaultRead = { state: 'unreachable', address: vault, why: `the chain could not be asked: ${(e as Error)?.message ?? e}` };
        now = null;
      }
    }
    let pinned: string | null;
    try {
      pinned = deps.chain.startingLedgerOf(now).account;
    } catch {
      pinned = null;
    }
    const acc = accountFacts ?? await accountFactsOf(companyAddress as Hex);
    const facts: FundingFacts = {
      label: vault,
      what,
      vault: vaultRead,
      vaultCircuits: circuitsRefusal(now, await deps.verifierKeys(), 'this vault is not funded'),
      pinnedAccount: pinned,
      companyAccount: companyAddress,
      committee,
      heldHere: deps.account.temporaryKey === undefined ? [] : [deps.account.temporaryKey],
      account: acc.read,
      accountCircuits: acc.circuits,
    };
    const refused = asFar(facts);
    return refused === null ? null : { ...refused, vaultRead };
  };

  const txFrom = (req: express.Request, res: express.Response): Uint8Array | null => {
    const body = z.object({ tx: z.string().min(1).max(VAULT_TX_LIMIT) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this request carries no transaction to send. Nothing was sent.' });
      return null;
    }
    return new Uint8Array(Buffer.from(body.data.tx, 'base64'));
  };

  const send = async (
    res: express.Response, accountId: string, what: string, arrival: VaultTxArrival, bytes: Uint8Array,
    check: (tx: unknown) => string | null | Promise<string | null>,
  ) => {
    if (typeof deps.ledger.sendVault !== 'function') {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not send transactions, so nothing was sent.' });
      return null;
    }
    try {
      return await deps.ledger.sendVault(accountId, what, arrival, bytes, check,
        arrival === 'finished-by-the-depositor' ? deps.readers.finished : deps.readers.proven);
    } catch (e: unknown) {
      const nothing = saysNothingWasSent(e);
      res.status(nothing ? 422 : 502).json({
        nothingWasSent: nothing, error: (e as { message?: string })?.message ?? 'unknown error',
      });
      return null;
    }
  };

  /* ---- keys ---- */

  r.put('/api/accounts/:id/vault-keys', ...guard, async (req, res) => {
    const body = z.object({
      committeeKey: z.object({ tag: z.literal('schnorr'), value: z.string().regex(HEX64) }),
      recordsKey: z.string().regex(HEX64),
      filingKey: z.string().regex(HEX64),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'these are not the three public keys a signer gives for a company\'s vaults.' });
      return;
    }
    const account = accountOf(req);
    const person = personOf(req);
    const before = deps.store.getVaultKeys(account.id, person);
    const given = body.data;
    if (before !== null) {
      const same = before.committeeKey.value === given.committeeKey.value
        && before.recordsKey === given.recordsKey && before.filingKey === given.filingKey;
      if (same) { res.json({ given: true }); return; }
      /* Every one of the three is worked out again from the same words and the same seat, so a
       * different set is a different wallet, and it does not silently replace the first. */
      res.status(409).json({
        error: 'you already gave this company different vault keys, from a different wallet or seat. They are '
          + 'kept, and these are not. If that is wrong, the company\'s signers must replace you.',
      });
      return;
    }
    deps.store.putVaultKeys({
      accountId: account.id, userId: person,
      committeeKey: given.committeeKey, recordsKey: given.recordsKey as Hex, filingKey: given.filingKey as Hex,
      givenAt: now().toISOString(),
    });
    res.status(201).json({ given: true });
  });

  r.get('/api/accounts/:id/vault-keys', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { committee, why } = await committeeNow(account);
    const mine = deps.store.getVaultKeys(account.id, personOf(req));
    const readers = account.memberUserIds
      .map((u) => deps.store.getVaultKeys(account.id, u)?.recordsKey ?? null)
      .filter((k): k is Hex => k !== null);
    res.json({ committee, why, readers, mine: mine === null ? null : { committeeKey: mine.committeeKey, recordsKey: mine.recordsKey, filingKey: mine.filingKey } });
  });

  /* ---- vaults ---- */

  r.get('/api/accounts/:id/vaults', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    const out = [];
    const accountFacts = company === null || committee === null ? undefined : await accountFactsOf(company.address);
    for (const v of deps.store.listCompanyVaults(account.id)) {
      const read = await authorityOf(v.vault);
      const refused: { why: string; heldByOthers: boolean; accountNotReady?: AccountNotReady; vaultRead?: AuthorityRead } | null =
        company === null || committee === null
          ? { why: why ?? 'this company has no committee yet.', heldByOthers: true }
          : await whyNotFunded(v.vault, read, committee, company.address, undefined, accountFacts);
      out.push({
        vault: v.vault,
        deployedAt: v.deployedAt,
        /* Where the vault stands, from the read the gate was given. */
        state: vaultState(refused?.vaultRead ?? read, refused),
        why: refused?.why ?? null,
      });
    }
    res.json({ rows: out });
  });

  r.post('/api/accounts/:id/vaults', ...guard, async (req, res) => {
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const verifierKeys = await deps.verifierKeys();
    let vault: Hex | null = null;
    const sent = await send(res, account.id, 'deploying a vault', 'proven-moving-nothing', bytes, (tx) => {
      const verdict = readVaultDeploy(tx, {
        account: company.address, verifierKeys, startingLedgerOf: deps.chain.startingLedgerOf,
      });
      if ('refusal' in verdict) return verdict.refusal;
      vault = verdict.vault as Hex;
      if (deps.store.getCompanyVault(vault) !== null) return 'a vault at that address is already recorded. Nothing was sent.';
      return null;
    });
    /* Recorded whenever a submission was attempted, including one that may have landed,
     * because a vault nobody recorded is one nobody would ever hand over. */
    if (vault !== null && (sent !== null || res.statusCode === 502)) {
      deps.store.putCompanyVault({
        accountId: account.id, vault, deployedAt: now().toISOString(),
        deployRef: sent?.ref ?? 'unknown', intended: { committee: committee.committee.map((k) => ({ ...k })), threshold: committee.threshold },
      });
    }
    if (sent === null) return;
    res.status(201).json({ vault, txRef: sent.ref, state: 'handover-owed' });
  });

  r.post('/api/accounts/:id/vaults/:vault/handover', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { committee, why } = await committeeNow(account);
    if (committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const read = await authorityOf(record.vault);
    if (read.state !== 'read') {
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be asked who holds this vault (${read.why}). Nothing was sent.` });
      return;
    }
    const sent = await send(res, account.id, 'handing a vault to the company\'s committee', 'proven-moving-nothing', bytes,
      (tx) => refusalForHandover(tx, { vault: record.vault, to: committee, onChain: read.authority }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, state: 'handover-sent' });
  });

  r.get('/api/accounts/:id/vaults/:vault/chain', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const account = accountOf(req);
    let state: unknown;
    try {
      state = await deps.chain.contractState(record.vault);
    } catch (e) {
      res.status(503).json({ error: `the chain could not be read for this vault: ${(e as Error)?.message ?? e}` });
      return;
    }
    if (state === null || state === undefined) {
      res.json({ vault: record.vault, onChain: false });
      return;
    }
    const { company, committee, why } = await committeeNow(account);
    const read = await authorityOf(record.vault);
    /* Whether the COMMITTEE HOLDS THIS VAULT is one answer, and a device's handover waits on it; whether money
     * may go in also needs the company account held by the committee, and is a second one. */
    /*
     * **TWO QUESTIONS, AND KEEPING THEM APART IS DELIBERATE.** Whether the
     * committee holds this vault is what a device's handover waits on, and it
     * is answered by the committee alone. Whether money may go in is the whole
     * gate, the account included, and every door that carries money asks that
     * one.
     */
    /*
     * **IN WORDS TRUE OF BOTH DIRECTIONS.** A device reads this view before a
     * deposit and before a payment out, and the service refuses both on this
     * same gate, so a person paying out is never told only about money going in.
     */
    const either = 'no money goes into or out of this vault';
    const refusal = company === null || committee === null
      ? why
      : (await whyNotFunded(
        record.vault, read, committee, company.address, state, undefined, either, asFarAsTheVault))?.why ?? null;
    const notFundable = refusal !== null || company === null || committee === null
      ? null
      : (await whyNotFunded(record.vault, read, committee, company.address, state, undefined, either))?.why ?? null;
    /*
     * **WHETHER THE NOTES BELOW WERE READ OFF A LEDGER OF THIS BUILD'S SHAPE**,
     * said beside them. A signer's device compares its own record of the notes
     * with them, and does so only when they were.
     */
    let notesFromThisBuild = false;
    let notesWhy: string | undefined;
    if (deps.chain.ledgerIsThisBuilds === undefined) {
      notesWhy = 'this service is not set up to check how a vault is laid out, so it does not vouch for which notes '
        + 'the vault holds. Whoever runs the service turns that check on';
    } else {
      try {
        await deps.chain.ledgerIsThisBuilds(state);
        notesFromThisBuild = true;
      } catch (e) {
        notesWhy = (e as Error)?.message ?? String(e);
      }
    }
    let everCreated: string[];
    try {
      everCreated = [...await deps.chain.everCreated(record.vault)];
    } catch (e) {
      res.status(503).json({ error: `the vault's history could not be read in full: ${(e as Error)?.message ?? e}` });
      return;
    }
    res.json({
      vault: record.vault,
      onChain: true,
      state: toBase64(deps.chain.serialize(state)),
      notes: deps.chain.notesOf(state),
      notesFromThisBuild,
      ...(notesWhy === undefined ? {} : { notesWhy }),
      everCreated,
      authority: read.state === 'read'
        ? { committee: read.authority.committee, threshold: read.authority.threshold, counter: String(read.authority.counter), shape: read.authority.shape }
        : null,
      committee,
      heldByCommittee: refusal === null,
      fundable: refusal === null && notFundable === null,
      why: refusal ?? notFundable,
    });
  });

  r.post('/api/accounts/:id/vaults/:vault/deposit', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    /* READ FROM THE CHAIN, NOW, AND NEVER FROM THE RECORD ABOVE. */
    const refusal = await whyNotFunded(record.vault, await authorityOf(record.vault), committee, company.address);
    if (refusal !== null) {
      res.status(409).json({ nothingWasSent: true, error: refusal.why });
      return;
    }
    const sent = await send(res, account.id, 'a deposit into a vault', 'finished-by-the-depositor', bytes,
      (tx) => refusalForDeposit(tx, { vault: record.vault }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /* ---- a private payment out ---- */

  /*
   * **WHAT A PAYMENT OUT IS BUILT ON, AND NOTHING THAT OPENS A NOTE.** The
   * device holds the pool and chooses the note; this answers only what the
   * chain holds, all of it read at one block, so the vault's call and the
   * account's answer to it are built on the same moment.
   */
  r.get('/api/accounts/:id/vaults/:vault/payout-state', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const company = await deps.company(record.accountId);
    if (company === null) {
      res.status(409).json({ error: 'this company has no contract on the chain this service can read, so nothing can be paid out.' });
      return;
    }
    if (deps.chain.payoutState === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain, so nothing can be paid out.' });
      return;
    }
    try {
      const state = await deps.chain.payoutState(record.vault, company.address);
      if (state === null) {
        res.status(409).json({ error: 'the chain does not hold this vault and this company\'s account at one block yet. Try again shortly.' });
        return;
      }
      res.json({ vault: record.vault, account: company.address, ...state });
    } catch (e) {
      res.status(503).json({ error: `the chain could not be read for this payment: ${(e as Error)?.message ?? e}` });
    }
  });

  /*
   * **WHAT A RAISE OR AN APPROVAL IS BUILT ON: THE ACCOUNT AS THE CHAIN HOLDS
   * IT, AND NOTHING A SIGNER HOLDS.** The device composes its own half; this
   * answers only public state, read at one block, and the account's address.
   */
  r.get('/api/accounts/:id/call-state', ...guard, async (req, res) => {
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ error: 'this company has no contract on the chain this service can read, so no round can be raised or approved on it yet.' });
      return;
    }
    if (deps.chain.accountCallState === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain, so no round can be raised or approved from a device.' });
      return;
    }
    try {
      const state = await deps.chain.accountCallState(company.address);
      if (state === null) {
        res.status(409).json({ error: 'the chain does not show this company\'s account yet. Try again shortly.' });
        return;
      }
      res.json({ account: company.address, ...state });
    } catch (e) {
      res.status(503).json({ error: `the chain could not be read for this company: ${(e as Error)?.message ?? e}` });
    }
  });

  r.get('/api/accounts/:id/vaults/:vault/events/:tx', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const tx = fold(String(req.params.tx));
    if (!HEX64.test(tx)) {
      res.status(400).json({ error: 'a transaction is named by its hash, sixty-four hex characters.' });
      return;
    }
    if (deps.chain.eventsOf === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain.' });
      return;
    }
    try {
      res.json({ events: await deps.chain.eventsOf(tx as Hex) });
    } catch (e) {
      /* The reader's own name travels, because "not yet" and "never" are different answers to a person waiting. */
      res.status(503).json({ error: (e as Error)?.message ?? String(e), kind: (e as Error)?.name ?? 'Error' });
    }
  });

  /*
   * **THE FEE ON A PRIVATE PAYMENT OUT, AND NOTHING ELSE.** Whether the company
   * approved it, whether its window is open and whether this person was already
   * paid are the account's to decide inside the same transaction; what is read
   * here is that it moves only this vault's own money, to one person, and needs
   * nothing from the fee payer but DUST.
   *
   * **AND ONLY OUT OF A VAULT THIS SERVICE CAN VOUCH FOR, READ FROM THE CHAIN
   * NOW** - the same answer a device waits on before it opens the vault's
   * record: held by the company's committee, changed once, running this build's
   * circuits, pinned to this company's account. A vault whose rules somebody
   * else changed may pay out by rules this service never compiled, and this
   * service does not pay the fee for that. The funding rules for money going in
   * are asked exactly as they are above and are not changed.
   */
  r.post('/api/accounts/:id/vaults/:vault/payout', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    /*
     * **THE SAME GATE, ASKED IN THIS DOOR'S OWN WORDS.** A person paying money
     * out is told why this payment is not paid for, never about money going in.
     */
    const unvouched = await whyNotFunded(
      record.vault, await authorityOf(record.vault), committee, company.address, undefined, undefined,
      'this service pays no fee for a payment out of this vault');
    if (unvouched !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: `${unvouched.why} Where the cause is that a signer joined or left, or the threshold changed, since `
          + 'the vault was handed over, its committee cannot be changed from this product yet, and no payment out '
          + 'of it is paid for until it can.',
      });
      return;
    }
    const sent = await send(res, account.id, 'a private payment out of a vault', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForPayout(tx, { vault: record.vault, account: company.address }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /*
   * **THE FEE ON A PUBLIC PAYMENT OUT, BEHIND THE SAME GATE.** The vault releases
   * its own public money to one public address; the account decides the rest
   * inside the transaction, exactly as for a private payment. What differs is
   * only what the transaction may carry, and `refusalForPublicPayout` says it.
   */
  r.post('/api/accounts/:id/vaults/:vault/public-payout', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const unvouched = await whyNotFunded(
      record.vault, await authorityOf(record.vault), committee, company.address, undefined, undefined,
      'this service pays no fee for a payment out of this vault');
    if (unvouched !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: `${unvouched.why} Where the cause is that a signer joined or left, or the threshold changed, since `
          + 'the vault was handed over, its committee cannot be changed from this product yet, and no payment out '
          + 'of it is paid for until it can.',
      });
      return;
    }
    const sent = await send(res, account.id, 'a public payment out of a vault', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForPublicPayout(tx, { vault: record.vault, account: company.address }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /* ---- who holds the company's rules ---- */

  const holdersOf = (account: SealedAccount): Map<string, string> => {
    const out = new Map<string, string>();
    for (const u of account.memberUserIds) {
      const k = deps.store.getVaultKeys(account.id, u)?.committeeKey;
      if (k) out.set(`${k.tag.toLowerCase()}:${k.value.toLowerCase()}`, u);
    }
    return out;
  };

  /*
   * **A HANDOVER SENT AND NOT YET SHOWN BY THE CHAIN IS NOT SENT AGAIN.** Every
   * copy would be built against the same counter, and the chain charges the fee
   * for each one it then refuses. Kept for as long as the handover could still
   * land, and in this process only: a restart forgets it, and the chain's own
   * counter still refuses a second one that arrives after the first landed.
   */
  const handoversSent = new Map<string, number>();
  /*
   * **NOT WHILE ONE SIGNER COULD ACT ALONE AND ANOTHER COULD LEAVE.** A handed-over account's committee cannot be
   * changed until signers can sign a change in their wallets, so a signer removed afterwards keeps their seat. At
   * a threshold of one, that one person could then replace the rules every vault of the company pays out by.
   */
  const whyNotYet = (threshold: number, signerCount: number): string | null =>
    threshold < 2 && signerCount > 1
      ? `this company has ${signerCount} signers and any one of them can approve alone. Once the account is handed over, `
        + 'its committee cannot be changed until signers can sign a change in their wallets, so a signer who later leaves '
        + 'could alone change the rules every vault pays out by. Raise the threshold to at least two first. Nothing was sent.'
      : null;
  const HANDOVER_LIFETIME_MS = 30 * 60_000;
  const handoverStillPending = (accountId: string): boolean => {
    const at = handoversSent.get(accountId);
    return at !== undefined && now().getTime() - at < HANDOVER_LIFETIME_MS;
  };

  r.get('/api/accounts/:id/authority', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    const holders = holdersOf(account);
    const serviceKey = deps.account.temporaryKey ?? null;
    const contracts: ContractAuthorityView[] = [];
    if (company !== null) {
      contracts.push(authorityView('account', await authorityOf(company.address), committee, holders, serviceKey));
      for (const v of deps.store.listCompanyVaults(account.id)) {
        contracts.push(authorityView('vault', await authorityOf(v.vault), committee, holders, serviceKey));
      }
    }
    const accountRow = contracts[0];
    const handover = company === null || committee === null
      ? { possible: false, why: why ?? 'this company has no committee yet.' }
      : accountRow?.heldByTheCompany
        ? { possible: false, why: 'the company\'s account is already held by its committee.' }
        : accountRow?.read === 'read' && accountRow.shape === 'one-key' && accountRow.changes === '0'
          ? !deps.account.handover
            ? { possible: false, why: 'this deployment keeps no temporary key for company accounts, so it cannot hand one over.' }
            : whyNotYet(company.threshold, account.signerCount) !== null
              ? { possible: false, why: whyNotYet(company.threshold, account.signerCount) }
            : handoverStillPending(account.id)
              ? { possible: false, why: 'the handover was sent and the chain has not shown it yet. Wait for it before sending another.' }
              : { possible: true, why: null }
          : { possible: false, why: accountRow?.why ?? 'the chain could not be asked who holds this company\'s account.' };
    res.json({
      company: company === null ? null : { address: company.address, threshold: company.threshold, signerCount: account.signerCount },
      committee,
      why,
      everySignerNeeded: company === null ? null : everySignerNeeded(account.signerCount, company.threshold),
      contracts: contracts.map((c) => ({ ...c, seats: c.seats.map((s) => ({ ...s, you: s.holder === personOf(req) })) })),
      handover: {
        ...handover,
        /* Said beside the button, because a handover cannot be undone from this screen. */
        permanent: 'Once handed over, the account is held by the company\'s committee as it stands now. Until '
          + 'signers can sign a change in their wallets, nobody can change that committee: a signer who joins '
          + 'or leaves afterwards stops every deposit into every vault, and a signer who leaves keeps their seat, '
          + `so with ${Math.max(0, (company?.threshold ?? 1) - 1)} of the signers who stay they could change the rules `
          + 'every vault pays out by.',
      },
      /*
       * A change after the handover is a replacement signed by the committee
       * that holds the contract now, and a committee key signs only inside its
       * holder's wallet. Until the wallet can be asked to, no change is offered.
       */
      change: {
        possible: false,
        why: 'Changing who holds these rules needs the signers who hold them now to sign the change in their own '
          + 'wallets, and the wallet cannot be asked to sign one yet. Until it can, a signer who joins or leaves '
          + 'is shown here; if the account\'s keys are no longer the company\'s, no money goes into any vault, and '
          + 'if a vault\'s are not, none goes into that vault.',
      },
    });
  });

  r.post('/api/accounts/:id/authority/handover', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const build = deps.account.handover;
    if (build === undefined) {
      res.status(503).json({
        nothingWasSent: true,
        error: 'this deployment keeps no temporary key for company accounts, so it cannot hand this one over. Nothing was sent.',
      });
      return;
    }
    const alone = whyNotYet(company.threshold, account.signerCount);
    if (alone !== null) {
      res.status(409).json({ nothingWasSent: true, error: alone });
      return;
    }
    /* The committee the pressing device checked, and nothing else, is the one installed. */
    const checked = z.object({
      committee: z.object({
        committee: z.array(z.object({ tag: z.string(), value: z.string() })),
        threshold: z.number(),
      }),
    }).safeParse(req.body);
    if (!checked.success || !sameCommittee(checked.data.committee, committee)) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'the committee your device checked is not the one this service would install now, so nothing was '
          + 'built. Nothing was sent; read the settings again and check it again.',
      });
      return;
    }
    if (handoverStillPending(account.id)) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'the handover was sent and the chain has not shown it yet, and a second copy would be refused after '
          + 'its fee was paid. Nothing was sent; wait for the first.',
      });
      return;
    }
    /* Held from here, before the first wait, so a second press arriving meanwhile is refused rather than paid. */
    handoversSent.set(account.id, now().getTime());
    const release = () => { handoversSent.delete(account.id); };
    const read = await authorityOf(company.address);
    if (read.state !== 'read') {
      release();
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be asked who holds this company's account (${read.why}). Nothing was sent.` });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await build({ read, to: committee });
    } catch (e) {
      release();
      res.status(409).json({ nothingWasSent: true, error: (e as Error)?.message ?? String(e) });
      return;
    }
    /* The service built it, and still reads it as if a stranger had: what is paid for is what is checked. */
    const sent = await send(res, account.id, 'handing the company account to its committee', 'proven-moving-nothing', bytes,
      (tx) => refusalForHandover(tx, { vault: company.address, to: committee, onChain: read.authority, contract: 'account' }));
    /* Only a refusal that says nothing was sent frees the account for another press; one that may have landed does not. */
    if (sent === null && res.statusCode !== 502) release();
    if (sent === null) return;
    res.json({ txRef: sent.ref, state: 'handover-sent' });
  });

  return r;
}
