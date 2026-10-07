/**
 * **A COMPANY'S ACCOUNT, CREATED BY ITS FOUNDING SIGNER'S DEVICE AND PAID FOR
 * HERE.**
 *
 *   POST /api/accounts/:id/creation          the deploy and its signed second step, recorded together, then the deploy sent
 *   POST /api/accounts/:id/creation/finish   the second step sent, the same bytes as recorded, once the chain shows the deploy
 *   POST /api/accounts/:id/creation/again    a deploy that ran out before it landed, carried again: the same account
 *   POST /api/accounts/:id/creation/pay-key  a step of committing the account to its pay-record key, built on the device
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
 * replaced, and no address is recorded for two companies. **The one exception
 * replaces bytes, never the account**: every transaction lives thirty minutes,
 * and one that ran out before it landed is carried again by the device - the same
 * deploy, so the same address, and the same signature - and recorded in the
 * place of the one that can never land, because nothing of it reached the chain.
 *
 * **NOTHING IS ADOPTED OR PAID INTO UNTIL THE SECOND STEP LANDS**: until then the
 * account does not run this build's circuits, and the money gate refuses it. The
 * creation is finished when every circuit the account runs carries this build's
 * key and the account is committed to the company's pay-record key.
 */
import express from 'express';
import { z } from 'zod';
import { readCompanyLabel } from 'midnight-identity/profile/company-label';
import { canonical, type Hex } from '../core/crypto.js';
import type { AccountDeploy, AccountOpeningRecord, SealedAccount } from '../core/types.js';
import type { Ledger } from '../core/ledger.js';
import { isAccountId, isSignerId } from '../core/account.js';
import type { CompanyFounded } from '../core/company-founding.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { readContractAuthority } from '../midnight/ledger.js';
import type { CommitteeKey } from '../midnight/vault-committee.js';
import { CREATION_STEPS, DEPLOYED_CIRCUITS } from '../midnight/deferral.js';
import { circuitsRefusal, readAccountDeploy, refusalForCreationInsert, refusalForPayKeyCall } from '../wiring/vault-submission.js';
import type { CompanyCreationState } from '../core/company-founding.js';
import { foundingStateRefusal } from '../core/founding-state.js';
import { foundingRosterRefusal, ROSTER_ID } from '../core/roster-record.js';
import type { CompanyRecordStore, SealedCompanyRecord } from '../midnight/sealed-record-wire.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const fold = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');
const TX_LIMIT = 1_000_000;

/**
 * How long after a recorded transaction's time to live it is counted as one
 * that can no longer land: a margin for a clock a little behind the chain's.
 */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export interface AccountCreationDeps {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: {
    getAccount(id: string): SealedAccount | null;
    putAccount(a: SealedAccount): void;
    getAccountOpening(accountId: string): AccountOpeningRecord | null;
    getAccountDeploy(accountId: string): AccountDeploy | null;
    recordAccountDeploy(d: AccountDeploy): boolean;
    replaceAccountDeploy(d: AccountDeploy): boolean;
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
    /** Every circuit's verifying key the account runs once created, as this build compiled them. */
    allKeys(): Promise<ReadonlyMap<string, Uint8Array>>;
    /** The commitment to the pay-record key an account's state holds, or null when none is written. */
    payKeyCommitment(state: unknown): Promise<Hex | null>;
    /** The bytes a signer signs, of the second step this service builds itself for an account. */
    insertDataToSign(account: string): Promise<Uint8Array>;
    /** Whether a signature verifies under a key, by the ledger's own check. */
    verifier(): Promise<(key: CommitteeKey, data: Uint8Array, signature: { tag: string; value: string }) => boolean>;
  };
  readonly now?: () => Date;
}



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

/* ------------------------------------------------ a company made on its founding signer's device */

/**
 * **THE NAMES A COMPANY'S SECRETS GO BY**, refused by name wherever they appear
 * in a creation, so a page that sends one is told which. The shape below
 * refuses any field it does not name in any case; this says why.
 */
const SECRETS_BY_NAME = [
  'signingSecret', 'wrappingSecret', 'blinding', 'viewingKey', 'assetBlinding', 'payoutSeeds', 'payRecordKey',
  'secrets', 'seed',
] as const;

/** The first secret's name a value carries anywhere inside it, or null. */
export function secretCarried(value: unknown, seen = new Set<unknown>()): string | null {
  if (typeof value !== 'object' || value === null || seen.has(value)) return null;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    if ((SECRETS_BY_NAME as readonly string[]).includes(k)) return k;
    const inner = secretCarried(v, seen);
    if (inner !== null) return inner;
  }
  return null;
}

const HEX_64 = z.string().regex(HEX64);
/** Sealed under a key this service does not hold: a nonce, an empty tag (it rides inside the body), and the body. */
const SEALED = z.object({ iv: z.string().regex(/^[0-9a-f]{24}$/u), tag: z.literal(''), body: z.string().regex(/^(?:[0-9a-f]{2})+$/u) }).strict();

/**
 * **THE SHAPE OF WHAT A FOUNDING SIGNER'S DEVICE SENDS WHEN IT MAKES A
 * COMPANY**: the seat's public halves and leaf, the company's record sealed
 * with its viewing key wrapped to that seat alone, and its first state sealed.
 * Every object is strict, so nothing else is carried.
 */
const FOUNDED = z.object({
  seat: z.object({
    signerId: z.string().refine(isSignerId), signingPublicKey: HEX_64, wrappingPublicKey: HEX_64, leaf: HEX_64,
  }).strict(),
  account: z.object({
    id: z.string().refine(isAccountId),
    createdAt: z.iso.datetime(),
    keyEpoch: z.literal(0),
    threshold: z.literal(1),
    signerCount: z.literal(1),
    memberUserIds: z.array(z.string()).length(1),
    pendingSigners: z.tuple([]),
    wrappedKeys: z.array(SEALED.extend({ signerId: z.string(), ephemeral: HEX_64 }).strict()).length(1),
    inboxPublicKey: HEX_64,
    sealedPolicy: SEALED,
    contractAddress: z.null(),
    addressSource: z.null(),
    companyLabel: z.string(),
    wiring: z.null(),
  }).strict(),
  /* The first roster, the founding signer's entry only, signed by the founding seat. Checked by `foundingRosterRefusal`. */
  roster: z.object({
    company: z.string(), kind: z.literal('roster'), id: z.literal(ROSTER_ID), version: z.literal(1), keyEpoch: z.literal(0),
    sealed: SEALED, wrapped: z.tuple([]),
    filedBy: z.object({ publicKey: HEX_64, signature: z.string().regex(/^[0-9a-f]{128}$/u) }).strict(),
  }).strict(),
  /* The first state, signed by the founding seat as the company's state record. Checked by `foundingStateRefusal`. */
  state: z.object({
    company: z.string(), kind: z.literal('state'), id: z.literal('0'), version: z.literal(1), keyEpoch: z.literal(0),
    sealed: SEALED, wrapped: z.tuple([]),
    filedBy: z.object({ publicKey: HEX_64, signature: z.string().regex(/^[0-9a-f]{128}$/u) }).strict(),
  }).strict(),
}).strict();

/** The whole request, on a chain: what the founding signer's wallet gave, and what their device made. */
const MADE_ON_THE_DEVICE = z.object({
  name: z.string().min(1),
  signers: z.array(z.object({ name: z.string().min(1), role: z.enum(['admin', 'approver', 'initiator', 'viewer']) }).strict()),
  threshold: z.number().int(),
  companyLabel: z.string(),
  foundingKey: z.object({ tag: z.literal('schnorr'), value: HEX_64 }).strict(),
  founding: FOUNDED,
}).strict();

export interface MadeOnTheDeviceDeps {
  readonly store: {
    getAccount(id: string): SealedAccount | null;
    listAccounts(): SealedAccount[];
    putAccount(a: SealedAccount): void;
    getAccountOpening(accountId: string): AccountOpeningRecord | null;
    recordAccountOpening(o: AccountOpeningRecord): boolean;
  };
  readonly ledger: Pick<Ledger, 'wiring' | 'takesCompaniesFromTheirFoundingSigner'>;
  /** The company's signed records, where its first state is filed: the only copy of it kept. */
  readonly records: Pick<CompanyRecordStore, 'get' | 'put'>;
}

type Answer = { readonly status: number; readonly body: Record<string, unknown> };
const refused = (status: number, code: string, error: string): Answer => ({ status, body: { code, error } });

/**
 * Files the first version of one of a company's records - its state, its
 * roster - once. The same record sent again, as a creation carried again
 * after its answer was lost, is already there and is not filed twice. False
 * when a different first version is kept for the company: it is never
 * written over.
 */
async function fileTheFirstVersion(records: Pick<CompanyRecordStore, 'get' | 'put'>, rec: SealedCompanyRecord): Promise<boolean> {
  const already = await records.get(rec.company, rec.kind, rec.id);
  if (already !== null) return canonical(already) === canonical(rec);
  try {
    await records.put(rec);
  } catch (e) {
    /* Another creation of the same company filed it between the read and the write: the same record is no refusal. */
    const now = await records.get(rec.company, rec.kind, rec.id);
    if (now === null) throw e;
    return canonical(now) === canonical(rec);
  }
  return true;
}

/**
 * **A COMPANY ITS FOUNDING SIGNER'S DEVICE MADE, RECORDED HERE.** On a chain
 * this service makes nothing for a company: it is sent the seat's public
 * halves and leaf, the company's record sealed with its viewing key wrapped to
 * that seat alone, and its first state sealed, and it checks they fit
 * together and fit the person and the label, and records them. A request that
 * carries any secret is refused before anything is read.
 *
 * **WHAT IT CAN CHECK AND WHAT IT CANNOT.** It checks the shape of every part;
 * that the company has one seat, the founding signer's, at a threshold of one,
 * held by the signed-in person; that the viewing key is wrapped to that seat
 * and to nobody else; that the record names the label the wallet drew; and
 * that its first state is sealed at the first key epoch. It cannot open
 * anything sealed, by design, so it cannot tell whether what is sealed is what
 * the device says it is: only the founding signer's own device can, and only
 * that device is harmed if it is not.
 *
 * **SENT AGAIN, IT IS THE SAME COMPANY.** The same request answers as the
 * first did and records nothing new; a different one for a company already
 * recorded is refused. So a page that did not hear the answer sends the same
 * request again and never makes a second company.
 *
 * Recorded in this order: what the account must be deployed from, then its
 * first state, then the company itself, which is what makes it a company.
 */
export async function recordTheCompanyMadeOnTheDevice(deps: MadeOnTheDeviceDeps, userId: string, body: unknown): Promise<Answer> {
  const secret = secretCarried(body);
  if (secret !== null) {
    return refused(400, 'a-secret-was-sent',
      `this creation carries "${secret}". A company's secrets are made on its founding signer's device and never leave `
        + 'it, so it is refused and nothing was created. Treat what was sent as disclosed, and make the company again.');
  }
  if (typeof body === 'object' && body !== null && !('founding' in body)) {
    return refused(409, 'made-on-the-founding-signers-device',
      'on a chain, a company is made on its founding signer\'s device: its secrets are made there and only what they '
        + 'seal is sent here. This creation carries none of it, so nothing was created.');
  }
  const parsed = MADE_ON_THE_DEVICE.safeParse(body);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || 'the request';
    return refused(400, 'not-a-company-made-on-the-device',
      `this is not a company as its founding signer's device makes one (${where} is not what it must be). Nothing was created.`);
  }
  const b = parsed.data;
  if (b.signers.length !== 1 || b.threshold !== 1) {
    return refused(400, 'founded-with-its-founding-signer-only',
      'a company is created with its founding signer only, at a threshold of one; every other signer joins by '
        + 'invitation, their seat made on their own device. Nothing was created.');
  }
  const label = readCompanyLabel(b.companyLabel);
  if (label === null) return refused(400, 'not-a-company-label', 'that is not a company label. Nothing was created.');
  const f: CompanyFounded = b.founding as unknown as CompanyFounded;
  const misfit = f.account.memberUserIds[0] !== userId ? 'its one seat is not held by the person creating it'
    : f.account.companyLabel !== label ? 'it names a label other than the one the wallet drew'
      : f.account.wrappedKeys[0]!.signerId !== f.seat.signerId ? 'its viewing key is wrapped to a seat other than the founding signer\'s'
        : /^0+$/u.test(f.seat.leaf) ? 'its seat is no seat'
          : foundingStateRefusal(f.state, f.account.id, f.seat.signingPublicKey) !== null
            ? `its first state is not one its founding seat signed for it (${foundingStateRefusal(f.state, f.account.id, f.seat.signingPublicKey)})`
            : foundingRosterRefusal(f.roster, f.account.id, f.seat.signingPublicKey) !== null
              ? `its first roster is not one its founding seat signed for it (${foundingRosterRefusal(f.roster, f.account.id, f.seat.signingPublicKey)})`
              : null;
  if (misfit !== null) {
    return refused(422, 'the-company-does-not-fit', `the company sent does not fit together: ${misfit}. Nothing was created.`);
  }
  const id = f.account.id;
  const opening: AccountOpeningRecord = { accountId: id, foundingKey: b.foundingKey, foundingLeaf: f.seat.leaf, companyLabel: label };
  const kept = { ...f.account, wiring: deps.ledger.wiring } as SealedAccount;
  const sameAccount = (a: SealedAccount): boolean => canonical({ ...a, wiring: null }) === canonical(f.account);
  const sameOpening = (o: AccountOpeningRecord): boolean => canonical(o) === canonical(opening);
  const already = deps.store.getAccount(id);
  if (already !== null) {
    if (sameAccount(already) && sameOpening(deps.store.getAccountOpening(id) ?? ({} as AccountOpeningRecord))) {
      /* A creation whose answer was lost after the company was recorded and before its roster was: the roster is filed now. */
      if (!await fileTheFirstVersion(deps.records, f.roster)) {
        return refused(409, 'company-taken', 'a different first roster is already kept under that id. Nothing was created.');
      }
      return { status: 200, body: { account: { id }, state: 'made' } };
    }
    return refused(409, 'company-taken', 'a different company is already recorded under that id. Nothing was created.');
  }
  const labelTaken = (): boolean => deps.store.listAccounts().some((a) => a.id !== id && a.companyLabel === label);
  if (labelTaken()) return refused(409, 'company-label-taken', 'another company has that label. Nothing was created.');
  if (deps.ledger.takesCompaniesFromTheirFoundingSigner !== true) {
    return refused(503, 'made-on-the-founding-signers-device', 'this deployment keeps no state for a company made on its founding signer\'s device. Nothing was created.');
  }
  if (!deps.store.recordAccountOpening(opening) && !sameOpening(deps.store.getAccountOpening(id)!)) {
    return refused(409, 'company-taken', 'a different company is already recorded under that id. Nothing was created.');
  }
  if (!await fileTheFirstVersion(deps.records, f.state)) {
    return refused(409, 'company-taken', 'a different first state is already kept under that id. Nothing was created.');
  }
  /* Asked once more: the state was kept with an await, and two companies with one label must not both be recorded. */
  if (labelTaken()) return refused(409, 'company-label-taken', 'another company has that label. Nothing was created.');
  deps.store.putAccount(kept);
  /* Its signers, filed as the company's first roster record: the record they are held in, and nowhere else. */
  if (!await fileTheFirstVersion(deps.records, f.roster)) {
    return refused(409, 'company-taken', 'a different first roster is already kept under that id. Nothing was created.');
  }
  return { status: 201, body: { account: { id }, state: 'made' } };
}

/**
 * **HOW A COMPANY IS CREATED ON THE LEDGER THIS SERVICE RUNS ON.** On a chain,
 * only as its founding signer's device made it: a creation that does not name
 * the founding signer's committee key is refused by name, and anything else is
 * recorded as the device sent it, with nothing made here. Null on the
 * simulated ledger, which keeps its own creation.
 */
export async function aCompanyCreatedOnTheLedger(deps: MadeOnTheDeviceDeps, userId: string, body: unknown): Promise<Answer | null> {
  if (deps.ledger.wiring === 'simulated') return null;
  const notHere = serverCreationRefusal(deps.ledger.wiring, (body as { foundingKey?: unknown } | null | undefined)?.foundingKey);
  if (notHere !== null) return { status: 409, body: notHere };
  return recordTheCompanyMadeOnTheDevice(deps, userId, body);
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

  /** When a recorded transaction can no longer land: its one intent's time to live. Null when it cannot be read. */
  const expiresAt = async (base64: string): Promise<Date | null> => {
    try {
      const tx = await deps.readers.proven(new Uint8Array(Buffer.from(base64, 'base64'))) as { intents?: Map<unknown, { ttl?: unknown }> };
      const intents = tx.intents instanceof Map ? [...tx.intents.values()] : [];
      const ttl = intents.length === 1 ? intents[0]!.ttl : undefined;
      return ttl instanceof Date ? ttl : null;
    } catch {
      return null;
    }
  };
  /**
   * Past its time to live, with a margin for a clock that is a little behind
   * the chain's: a transaction that may still land is never counted as one that
   * cannot, so nothing is carried again while the first could still arrive.
   */
  const ranOut = async (base64: string): Promise<boolean> => {
    const ttl = await expiresAt(base64);
    return ttl !== null && now().getTime() > ttl.getTime() + EXPIRY_MARGIN_MS;
  };

  /**
   * **WHERE A COMPANY'S CREATION STANDS, FROM ITS RECORD AND THE CHAIN.**
   * Finished is judged by what the chain holds: every circuit the account runs
   * has this build's verifier key, and the account is committed to the
   * company's pay-record key. Names alone are never enough.
   */
  const standingOf = async (record: AccountDeploy | null): Promise<CompanyCreationState> => {
    if (record === null) return 'not-created';
    let state: unknown;
    try {
      state = await deps.contractState(record.address);
    } catch {
      return 'unknown';
    }
    if (state === null || state === undefined) return (await ranOut(record.deploy)) ? 'deploy-expired' : 'deploy-sent';
    if (circuitsRefusal(state, await deps.expected.allKeys(), 'this company\'s account', DEPLOYED_CIRCUITS, 'the account\'s') !== null) {
      return (await ranOut(record.insert)) ? 'finish-expired' : 'finish-owed';
    }
    try {
      return (await deps.expected.payKeyCommitment(state)) === null ? 'pay-key-owed' : 'finished';
    } catch {
      return 'unknown';
    }
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

  /** Reads a deploy and its second step against what was recorded when the company was made: the account they make, or why not. */
  const readBoth = async (opening: AccountOpeningRecord, deploy: string, insert: string): Promise<{ address: string } | { refusal: string }> => {
    try {
      const verdict = readAccountDeploy(await deps.readers.proven(new Uint8Array(Buffer.from(deploy, 'base64'))), {
        foundingKey: opening.foundingKey, verifierKeys: await deps.expected.firstKeys(), circuits: CREATION_STEPS.first,
        expectedState: await deps.expected.stateOf(opening),
      });
      if ('refusal' in verdict) return { refusal: verdict.refusal };
      const address = fold(verdict.vault);
      const insertRefused = await insertCheck(opening, address)(await deps.readers.proven(new Uint8Array(Buffer.from(insert, 'base64'))));
      return insertRefused !== null ? { refusal: insertRefused } : { address };
    } catch (e) {
      return { refusal: `what was sent could not be read as transactions: ${(e as Error)?.message ?? String(e)}. Nothing was sent.` };
    }
  };

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
    const read = await readBoth(opening, body.data.deploy, body.data.insert);
    if ('refusal' in read) {
      res.status(422).json({ nothingWasSent: true, error: read.refusal });
      return;
    }
    const address = read.address;
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
    const sent = await send(res, account.id, 'creating the company\'s account', new Uint8Array(Buffer.from(body.data.deploy, 'base64')), deployCheck(opening));
    if (sent === null) return;
    res.status(201).json({ account: address, state: 'deploy-sent', txRef: sent.ref });
  });

  /*
   * **A DEPLOY THAT RAN OUT BEFORE IT LANDED, CARRIED AGAIN AND RECORDED IN ITS
   * PLACE.** Only once the recorded one can no longer land and the chain shows
   * nothing at its address, so nothing ever reached the chain; and only the same
   * deploy, making the same account, with the second step for that account
   * signed by the founding signer's recorded key. Read before it is recorded,
   * recorded before it is sent.
   */
  r.post('/api/accounts/:id/creation/again', ...guard, async (req, res) => {
    const body = z.object({ deploy: z.string().min(1).max(TX_LIMIT), insert: z.string().min(1).max(TX_LIMIT) }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this request does not carry the account\'s deploy and its signed second step. Nothing was sent.' });
      return;
    }
    const account = accountOf(req);
    const opening = deps.store.getAccountOpening(account.id);
    const recorded = deps.store.getAccountDeploy(account.id);
    if (opening === null || recorded === null) {
      res.status(409).json({ nothingWasSent: true, error: 'this company\'s account has not been sent, so there is nothing to send again. Nothing was sent.' });
      return;
    }
    const standing = await standingOf(recorded);
    if (standing !== 'deploy-expired') {
      res.status(409).json({
        nothingWasSent: true, state: standing,
        error: 'the deploy recorded for this company can still land, or already has, so it is not replaced. Nothing was sent.',
      });
      return;
    }
    const read = await readBoth(opening, body.data.deploy, body.data.insert);
    if ('refusal' in read) {
      res.status(422).json({ nothingWasSent: true, error: read.refusal });
      return;
    }
    if (read.address !== fold(recorded.address)) {
      res.status(422).json({
        nothingWasSent: true,
        error: 'this deploy creates another account than the one recorded for this company, and its founding signer\'s wallet signed for that one. Nothing was sent.',
      });
      return;
    }
    if (await ranOut(body.data.deploy)) {
      res.status(422).json({ nothingWasSent: true, error: 'this deploy has run out already, so it was not recorded. Carry it again. Nothing was sent.' });
      return;
    }
    if (!deps.store.replaceAccountDeploy({ ...recorded, deploy: body.data.deploy, insert: body.data.insert, recordedAt: now().toISOString() })) {
      res.status(409).json({ nothingWasSent: true, error: 'the deploy recorded for this company could not be replaced. Nothing was sent.' });
      return;
    }
    const sent = await send(res, account.id, 'creating the company\'s account, carried again', new Uint8Array(Buffer.from(body.data.deploy, 'base64')), deployCheck(opening));
    if (sent === null) return;
    res.json({ account: recorded.address, state: 'deploy-sent', txRef: sent.ref });
  });

  r.post('/api/accounts/:id/creation/finish', ...guard, async (req, res) => {
    const body = z.object({ insert: z.string().min(1).max(TX_LIMIT).optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this request carries something other than the account\'s second step. Nothing was sent.' });
      return;
    }
    const account = accountOf(req);
    const opening = deps.store.getAccountOpening(account.id);
    let recorded = deps.store.getAccountDeploy(account.id);
    if (opening === null || recorded === null) {
      res.status(409).json({ nothingWasSent: true, error: 'this company\'s account has not been created from its founding signer\'s browser, so there is nothing to finish. Nothing was sent.' });
      return;
    }
    const standing = await standingOf(recorded);
    if (standing === 'finished' || standing === 'pay-key-owed') {
      res.json({ account: recorded.address, state: standing });
      return;
    }
    if (standing === 'finish-expired' && body.data.insert === undefined) {
      res.status(409).json({
        nothingWasSent: true, state: standing,
        error: 'the second step recorded for this company ran out before it was sent. Carry it again: the same signature, in a fresh transaction. Nothing was sent.',
      });
      return;
    }
    if (standing !== 'finish-owed' && standing !== 'finish-expired') {
      res.status(409).json({
        nothingWasSent: true, state: standing,
        error: standing === 'deploy-sent' || standing === 'deploy-expired'
          ? 'the chain does not show the company\'s account yet, so its second step cannot be sent. Nothing was sent; try again when it does.'
          : 'the chain could not be asked about the company\'s account. Nothing was sent; try again.',
      });
      return;
    }
    if (body.data.insert !== undefined && body.data.insert !== recorded.insert) {
      /* The same signed step, carried again: read as the first was, and recorded in its place before it is sent. */
      if (standing !== 'finish-expired') {
        res.status(409).json({ nothingWasSent: true, state: standing, error: 'the second step recorded for this company can still land, so it is not replaced. Nothing was sent.' });
        return;
      }
      let refused: string | null;
      try {
        refused = await insertCheck(opening, recorded.address)(await deps.readers.proven(new Uint8Array(Buffer.from(body.data.insert, 'base64'))));
      } catch (e) {
        refused = `what was sent could not be read as a transaction: ${(e as Error)?.message ?? String(e)}. Nothing was sent.`;
      }
      if (refused === null && await ranOut(body.data.insert)) refused = 'this second step has run out already, so it was not recorded. Carry it again. Nothing was sent.';
      if (refused !== null) {
        res.status(422).json({ nothingWasSent: true, error: refused });
        return;
      }
      const replaced = { ...recorded, insert: body.data.insert, recordedAt: now().toISOString() };
      if (!deps.store.replaceAccountDeploy(replaced)) {
        res.status(409).json({ nothingWasSent: true, error: 'the second step recorded for this company could not be replaced. Nothing was sent.' });
        return;
      }
      recorded = replaced;
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

  /*
   * **THE COMPANY'S PAY-RECORD KEY, COMMITTED AND SEALED FROM ITS FOUNDING
   * SIGNER'S DEVICE.** The proposal that commits the account to the key is raised,
   * approved and carried out by sealing the founding signer's copy, each built
   * and proved on that device. This service reads each as exactly one call of
   * that circuit to this company's account, moving nothing, and pays the fee.
   * Only while the account is complete and not yet committed to a key. One of
   * each is sent at a time.
   */
  const payKeySending = new Set<string>();
  r.post('/api/accounts/:id/creation/pay-key', ...guard, async (req, res) => {
    const body = z.object({
      call: z.enum(['propose', 'approve', 'sealPayKey']),
      tx: z.string().min(1).max(TX_LIMIT),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this is not a step of committing the company to its pay-record key. Nothing was sent.' });
      return;
    }
    const account = accountOf(req);
    const recorded = deps.store.getAccountDeploy(account.id);
    const standing = await standingOf(recorded);
    if (recorded === null || standing !== 'pay-key-owed') {
      res.status(409).json({
        nothingWasSent: true, state: standing,
        error: standing === 'finished'
          ? 'this company\'s account is already committed to its pay-record key. Nothing was sent.'
          : 'this company\'s account is not finished yet, so its pay-record key cannot be committed. Nothing was sent.',
      });
      return;
    }
    const key = `${account.id}:${body.data.call}`;
    if (payKeySending.has(key)) {
      res.status(409).json({ nothingWasSent: true, error: 'this step is being sent right now by another request. Nothing was sent.' });
      return;
    }
    payKeySending.add(key);
    try {
      const what = body.data.call === 'propose' ? 'raising the proposal that commits the company to its pay-record key'
        : body.data.call === 'approve' ? 'approving the proposal that commits the company to its pay-record key'
          : 'sealing the company\'s pay-record key to its founding signer';
      const sent = await send(res, account.id, what, new Uint8Array(Buffer.from(body.data.tx, 'base64')),
        (tx) => refusalForPayKeyCall(tx, { account: recorded.address, circuit: body.data.call }));
      if (sent === null) return;
      res.json({ txRef: sent.ref });
    } finally {
      payKeySending.delete(key);
    }
  });

  return r;
}
