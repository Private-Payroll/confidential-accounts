/**
 * **A COMPANY'S ACCOUNT, CREATED BY ITS FOUNDING SIGNER'S DEVICE AND PAID FOR
 * HERE.**
 *
 *   POST /api/accounts/:id/creation          the deploy and its signed second step, recorded together, then the deploy sent
 *   POST /api/accounts/:id/creation/finish   the second step sent, the same bytes as recorded, once the chain shows the deploy
 *   GET  /api/accounts/:id/creation          where the creation stands, read from the record and the chain
 *
 * **THIS SERVICE BUILDS NOTHING HERE AND HOLDS NO KEY.** The founding signer's
 * device built the deploy, held by their own committee key from its first
 * transaction, and their wallet signed the second step for it before anything
 * was sent. This service reads both as a stranger's, against what it recorded
 * when the company was made, and pays only the network fee.
 *
 * **RECORDED BEFORE ANYTHING IS SENT, AND NEVER WRITTEN OVER.** A rebuilt deploy
 * draws a new nonce and so a new address, so a retry sends the bytes recorded the
 * first time and never a second account; a company's recorded address is never
 * replaced, and no address is recorded for two companies.
 *
 * **NOTHING IS ADOPTED OR PAID INTO UNTIL THE SECOND STEP LANDS**: until then the
 * account does not run this build's circuits, and the money gate refuses it.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { AccountDeploy, AccountOpeningRecord, SealedAccount } from '../core/types.js';
import type { Ledger } from '../core/ledger.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { readContractAuthority } from '../midnight/ledger.js';
import type { CommitteeKey } from '../midnight/vault-committee.js';
import { CREATION_STEPS } from '../midnight/deferral.js';
import { readAccountDeploy, refusalForCreationInsert } from '../wiring/vault-submission.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const fold = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');
const TX_LIMIT = 1_000_000;

/** Where a company's creation stands. */
export type CreationStanding =
  /** Nothing has been recorded: the founding signer's device has not sent the deploy. */
  | 'not-created'
  /** Recorded and sent, and the chain does not show the account yet. */
  | 'deploy-sent'
  /** The chain shows the account and not the second step: it can be paid into by nobody yet. */
  | 'finish-owed'
  /** Both steps are on the chain. */
  | 'finished'
  /** The chain could not be asked. */
  | 'unknown';

export interface AccountCreationDeps {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: {
    getAccount(id: string): SealedAccount | null;
    putAccount(a: SealedAccount): void;
    getAccountOpening(accountId: string): AccountOpeningRecord | null;
    getAccountDeploy(accountId: string): AccountDeploy | null;
    recordAccountDeploy(d: AccountDeploy): boolean;
  };
  readonly ledger: Pick<Ledger, 'sendVault'>;
  /** The account's contract state as the indexer serves it, or null when there is none. */
  readonly contractState: (address: Hex) => Promise<unknown | null>;
  /** Where a company's account address is recorded, so the ledger finds it. */
  readonly register: (accountId: string, address: string) => Promise<void>;
  readonly readers: { proven(bytes: Uint8Array): Promise<unknown> };
  /** What this service builds itself to read a creation against. */
  readonly expected: {
    /** The account's whole state at deploy, from what was recorded when the company was made, serialized. */
    stateOf(opening: AccountOpeningRecord): Promise<Uint8Array>;
    /** The first step's circuits' verifying keys, as this build compiled them. */
    firstKeys(): Promise<ReadonlyMap<string, Uint8Array>>;
    /** The bytes a signer signs, of the second step this service builds itself for an account. */
    insertDataToSign(account: string): Promise<Uint8Array>;
    /** Whether a signature verifies under a key, by the ledger's own check. */
    verifier(): Promise<(key: CommitteeKey, data: Uint8Array, signature: { tag: string; value: string }) => boolean>;
  };
  readonly now?: () => Date;
}


/** The operations a contract's state carries, by name. Empty for a state that cannot be read. */
const operationsOf = (state: unknown): string[] => {
  try {
    return ((state as { operations(): unknown[] }).operations()).map((n) => (n instanceof Uint8Array ? new TextDecoder().decode(n) : String(n)));
  } catch {
    return [];
  }
};

/**
 * **ON A CHAIN THIS SERVICE CREATES NO COMPANY'S ACCOUNT**, so a creation that
 * does not name the founding signer's committee key - the old path, which
 * deployed under a key this service held - is refused by name. The simulated
 * ledger development and the tests run on keeps its own creation.
 */
export function serverCreationRefusal(wiring: string, foundingKey: unknown): { code: string; error: string } | null {
  if (wiring === 'simulated' || foundingKey !== undefined) return null;
  return {
    code: 'created-from-the-founding-signers-browser',
    error: 'on a chain, a company is created from its founding signer\'s browser, held by their own key from its first '
      + 'transaction, and this service deploys no company\'s account. Nothing was created.',
  };
}

export function accountCreationRoutes(deps: AccountCreationDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? (() => new Date());
  const guard = [deps.signedIn, express.json({ limit: '4mb' }), deps.member];

  const accountOf = (req: express.Request): SealedAccount => {
    const a = deps.store.getAccount(String(req.params.id));
    if (!a) throw new Error('account not found');
    return a;
  };

  const standingOf = async (record: AccountDeploy | null): Promise<CreationStanding> => {
    if (record === null) return 'not-created';
    let state: unknown;
    try {
      state = await deps.contractState(record.address);
    } catch {
      return 'unknown';
    }
    if (state === null || state === undefined) return 'deploy-sent';
    const ops = operationsOf(state);
    return CREATION_STEPS.second.every((c) => ops.includes(c)) ? 'finished' : 'finish-owed';
  };

  const send = async (res: express.Response, accountId: string, what: string, bytes: Uint8Array, check: (tx: unknown) => string | null | Promise<string | null>) => {
    if (typeof deps.ledger.sendVault !== 'function') {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not send transactions, so nothing was sent.' });
      return null;
    }
    try {
      return await deps.ledger.sendVault(accountId, what, 'proven-moving-nothing', bytes, check, deps.readers.proven);
    } catch (e: unknown) {
      const nothing = saysNothingWasSent(e);
      res.status(nothing ? 422 : 502).json({ nothingWasSent: nothing, error: (e as { message?: string })?.message ?? 'unknown error' });
      return null;
    }
  };

  const deployCheck = (opening: AccountOpeningRecord) => async (tx: unknown): Promise<string | null> => {
    const verdict = readAccountDeploy(tx, {
      foundingKey: opening.foundingKey, verifierKeys: await deps.expected.firstKeys(), circuits: CREATION_STEPS.first,
      expectedState: await deps.expected.stateOf(opening),
    });
    return 'refusal' in verdict ? verdict.refusal : null;
  };
  const insertCheck = (opening: AccountOpeningRecord, account: string) => async (tx: unknown): Promise<string | null> =>
    refusalForCreationInsert(tx, {
      account, foundingKey: opening.foundingKey, expectedDataToSign: await deps.expected.insertDataToSign(account),
      verify: await deps.expected.verifier(),
    });

  r.get('/api/accounts/:id/creation', ...guard, async (req, res) => {
    const account = accountOf(req);
    const record = deps.store.getAccountDeploy(account.id);
    res.json({ state: await standingOf(record), account: record?.address ?? null });
  });

  r.post('/api/accounts/:id/creation', ...guard, async (req, res) => {
    const body = z.object({
      deploy: z.string().min(1).max(TX_LIMIT),
      insert: z.string().min(1).max(TX_LIMIT),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this request does not carry the account\'s deploy and its signed second step. Nothing was sent.' });
      return;
    }
    const account = accountOf(req);
    const opening = deps.store.getAccountOpening(account.id);
    if (opening === null) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'this company was not created from its founding signer\'s browser, so there is nothing its account can be read against. Nothing was sent.',
      });
      return;
    }
    const recorded = deps.store.getAccountDeploy(account.id);
    /* A retry sends what was recorded the first time, whatever it carries now. */
    if (recorded !== null) {
      if (recorded.deploy !== body.data.deploy || recorded.insert !== body.data.insert) {
        res.status(409).json({
          nothingWasSent: true,
          error: 'this company\'s account was already created from another deploy, and a company has one account. Nothing was sent.',
          account: recorded.address,
        });
        return;
      }
      if ((await standingOf(recorded)) !== 'deploy-sent') {
        res.json({ account: recorded.address, state: await standingOf(recorded) });
        return;
      }
      const again = await send(res, account.id, 'creating the company\'s account, again', new Uint8Array(Buffer.from(recorded.deploy, 'base64')), deployCheck(opening));
      if (again === null) return;
      res.json({ account: recorded.address, state: 'deploy-sent', txRef: again.ref });
      return;
    }
    /* Both read before either is recorded or sent: nothing is paid for until both are exactly what they must be. */
    const deployBytes = new Uint8Array(Buffer.from(body.data.deploy, 'base64'));
    const insertBytes = new Uint8Array(Buffer.from(body.data.insert, 'base64'));
    let address: string;
    try {
      const verdict = readAccountDeploy(await deps.readers.proven(deployBytes), {
        foundingKey: opening.foundingKey, verifierKeys: await deps.expected.firstKeys(), circuits: CREATION_STEPS.first,
        expectedState: await deps.expected.stateOf(opening),
      });
      if ('refusal' in verdict) {
        res.status(422).json({ nothingWasSent: true, error: verdict.refusal });
        return;
      }
      address = fold(verdict.vault);
      const insertRefused = await insertCheck(opening, address)(await deps.readers.proven(insertBytes));
      if (insertRefused !== null) {
        res.status(422).json({ nothingWasSent: true, error: insertRefused });
        return;
      }
    } catch (e) {
      res.status(422).json({ nothingWasSent: true, error: `what was sent could not be read as transactions: ${(e as Error)?.message ?? String(e)}. Nothing was sent.` });
      return;
    }
    if (!HEX64.test(address) || !deps.store.recordAccountDeploy({
      accountId: account.id, address: address as Hex, foundingKey: opening.foundingKey,
      deploy: body.data.deploy, insert: body.data.insert, recordedAt: now().toISOString(),
    })) {
      res.status(409).json({ nothingWasSent: true, error: 'an account at that address is already recorded for a company. Nothing was sent.' });
      return;
    }
    /* The address is the company's from here: recorded on the company, and where the ledger looks for it. */
    deps.store.putAccount({ ...account, contractAddress: address, addressSource: 'chain' });
    await deps.register(account.id, address);
    const sent = await send(res, account.id, 'creating the company\'s account', deployBytes, deployCheck(opening));
    if (sent === null) return;
    res.status(201).json({ account: address, state: 'deploy-sent', txRef: sent.ref });
  });

  r.post('/api/accounts/:id/creation/finish', ...guard, async (req, res) => {
    const account = accountOf(req);
    const opening = deps.store.getAccountOpening(account.id);
    const recorded = deps.store.getAccountDeploy(account.id);
    if (opening === null || recorded === null) {
      res.status(409).json({ nothingWasSent: true, error: 'this company\'s account has not been created from its founding signer\'s browser, so there is nothing to finish. Nothing was sent.' });
      return;
    }
    const standing = await standingOf(recorded);
    if (standing === 'finished') {
      res.json({ account: recorded.address, state: 'finished' });
      return;
    }
    if (standing !== 'finish-owed') {
      res.status(409).json({
        nothingWasSent: true, state: standing,
        error: standing === 'deploy-sent'
          ? 'the chain does not show the company\'s account yet, so its second step cannot be sent. Nothing was sent; try again when it does.'
          : 'the chain could not be asked about the company\'s account. Nothing was sent; try again.',
      });
      return;
    }
    const read = await readContractAuthority((a) => deps.contractState(a as Hex), recorded.address);
    if (read.state !== 'read') {
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be asked who holds the company's account (${read.why}). Nothing was sent; try again.` });
      return;
    }
    if (read.authority.counter !== 0n) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'the company\'s account was changed before its second step landed, so the step recorded for it can never land and '
          + 'the account cannot be finished. Create the company again. Nothing was sent.',
      });
      return;
    }
    const sent = await send(res, account.id, 'finishing the company\'s account', new Uint8Array(Buffer.from(recorded.insert, 'base64')),
      insertCheck(opening, recorded.address));
    if (sent === null) return;
    res.json({ account: recorded.address, state: 'finish-sent', txRef: sent.ref });
  });

  return r;
}
