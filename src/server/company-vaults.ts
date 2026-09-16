/**
 * **A COMPANY'S VAULTS, AS ITS SIGNERS' DEVICES CREATE, HAND OVER AND FUND
 * THEM.**
 *
 * Nothing on these routes builds, proves or signs a transaction, and nothing a
 * device sends here carries a secret: the device builds and proves; the
 * depositor's own wallet puts in and signs for any coin; this service reads
 * what arrives, refuses anything that is not exactly what the route is for, and
 * pays only the network fee. What it answers about a vault's rules is read from
 * the chain each time it is asked.
 *
 *   PUT  /api/accounts/:id/vault-keys                   a signer's three public vault keys
 *   GET  /api/accounts/:id/vault-keys                   the committee, and who can read the records
 *   GET  /api/accounts/:id/vaults                       the company's vaults, and who holds each on chain
 *   POST /api/accounts/:id/vaults                       a vault deployed with a temporary key
 *   POST /api/accounts/:id/vaults/:vault/handover       that vault handed to the company's committee
 *   GET  /api/accounts/:id/vaults/:vault/chain          what the chain holds for one vault
 *   POST /api/accounts/:id/vaults/:vault/deposit        a deposit the depositor's wallet has paid for
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
import { committeeOf, whyNoCommittee, type Committee } from '../midnight/vault-committee.js';
import {
  circuitsRefusal, fundingRefusal, readVaultDeploy, refusalForDeposit, refusalForHandover,
  type VaultStartingLedger,
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
  /** What the vault's ledger holds, read through the vault's own compiled ledger. */
  startingLedgerOf(state: unknown): VaultStartingLedger;
  /** Every output the chain has ever created for the vault. */
  everCreated(vault: Hex): Promise<ReadonlySet<string>>;
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
   * **WHETHER MONEY MAY GO INTO THIS VAULT, READ FROM THE CHAIN AS IT IS NOW.**
   * The committee's keys are not enough on their own: a key that held the rules
   * before the handover could have swapped a circuit, used it to rewrite the
   * vault's ledger, put the circuit back and installed the committee itself,
   * and the chain would then show the committee and this build's circuits. So a
   * vault is funded only when the chain also shows exactly one change to its
   * rules - the handover - its circuits are this build's, and the account it is
   * pinned to now is still the company's.
   */
  const whyNotFunded = async (
    vault: Hex, read: AuthorityRead, committee: Committee, companyAddress: string, state?: unknown,
  ): Promise<{ why: string; heldByOthers: boolean } | null> => {
    const held = fundingRefusal(read, committee);
    if (held !== null) return { why: held, heldByOthers: true };
    if (read.state !== 'read' || read.authority.counter !== 1n) {
      const changes = read.state === 'read' ? String(read.authority.counter) : 'an unknown number of';
      return {
        why: `this vault's rules have been changed ${changes} times, and a vault handed straight to its committee `
          + 'has been changed once, so what it accepts cannot be vouched for and no money goes in. Nothing was sent.',
        heldByOthers: false,
      };
    }
    let now = state;
    if (now === undefined) {
      try {
        now = await deps.chain.contractState(vault);
      } catch (e) {
        return { why: `the chain could not be read for this vault (${(e as Error)?.message ?? e}). Nothing was sent.`, heldByOthers: false };
      }
    }
    const circuits = circuitsRefusal(now, await deps.verifierKeys(), 'this vault is not funded');
    if (circuits !== null) return { why: circuits, heldByOthers: false };
    let pinned: string;
    try {
      pinned = deps.chain.startingLedgerOf(now).account;
    } catch {
      return { why: 'this vault\'s state on the chain cannot be read as a vault\'s, so no money goes in. Nothing was sent.', heldByOthers: false };
    }
    if (fold(pinned) !== fold(companyAddress)) {
      return {
        why: 'this vault is now pinned to an account other than the company\'s, so money put in it would be paid out '
          + 'on somebody else\'s approvals. No money goes in. Nothing was sent.',
        heldByOthers: false,
      };
    }
    return null;
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
        arrival === 'proven-moving-nothing' ? deps.readers.proven : deps.readers.finished);
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
    for (const v of deps.store.listCompanyVaults(account.id)) {
      const read = await authorityOf(v.vault);
      const refused = company === null || committee === null
        ? { why: why ?? 'this company has no committee yet.', heldByOthers: true }
        : await whyNotFunded(v.vault, read, committee, company.address);
      out.push({
        vault: v.vault,
        deployedAt: v.deployedAt,
        state: refused === null ? 'held-by-committee'
          : !refused.heldByOthers ? 'not-fundable'
            : read.state === 'read' ? 'handover-owed'
              : read.state === 'absent' ? 'not-on-chain-yet' : 'unknown',
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
    const refusal = company === null || committee === null
      ? why
      : (await whyNotFunded(record.vault, read, committee, company.address, state))?.why ?? null;
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
      everCreated,
      authority: read.state === 'read'
        ? { committee: read.authority.committee, threshold: read.authority.threshold, counter: String(read.authority.counter), shape: read.authority.shape }
        : null,
      committee,
      heldByCommittee: refusal === null,
      why: refusal,
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

  return r;
}
