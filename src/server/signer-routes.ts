/**
 * **A COMPANY'S SIGNERS ON THE PRODUCT'S SERVER: ITS ROSTER FILED BY ITS SEATS'
 * DEVICES, AND NOTHING HERE OPENS IT.**
 *
 * The roster - who holds a seat, their keys, their leaf, their vault keys - is
 * one of the company's own records, sealed and signed on a seat's device. It
 * changes in three ways, each a route here, each filed through the one
 * company-record filing (`fileCompanyRecord`, check S):
 *
 *   · **a signer admitted** once the chain holds their seat: the admitting
 *     seat's device files the roster with them in it and wraps the company's key
 *     to them; this keeps, in plain text, what the member gate needs.
 *   · **vault keys offered** by a new signer, who cannot file the roster until
 *     the company's committee holds their key: public keys and signatures,
 *     checked against the directory entry their own wallet signed, kept as one
 *     waiting offer per seat, for the person who made it, and never read as
 *     the roster.
 *   · **the roster filed** by a seat the company already believes, folding in
 *     the offers it checked against the roster it opened; an offer goes only
 *     once the index the filing makes holds its keys.
 */
import express from 'express';
import { z } from 'zod';
import { readAccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Ledger } from '../core/ledger.js';
import type { SealedAccount } from '../core/types.js';
import { ROSTER_ID } from '../core/roster-record.js';
import { offerAsKept, vaultKeysOfferRefusal, type CompanyVaultKeyIndex, type VaultKeysOffer } from '../core/vault-keys.js';
import type { CompanyRecordStore } from '../midnight/sealed-record-wire.js';
import { fileCompanyRecord, type FilingAnswer } from './company-records-route.js';
import type { DirectoryNow } from './seat-directory-route.js';

export interface SignerRouteStore {
  getAccount(accountId: string): SealedAccount | null;
  putAccount(a: SealedAccount): void;
  putVaultKeyIndex(k: CompanyVaultKeyIndex): void;
  vaultKeysOffersOf(accountId: string): VaultKeysOffer[];
  putVaultKeysOffer(accountId: string, seat: string, offer: VaultKeysOffer): void;
  dropVaultKeysOffers(accountId: string, seats: readonly string[]): void;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const low = (h: unknown): string => String(h ?? '').toLowerCase();

/** Whether the index a roster filing makes holds an offer's keys: its committee key, its records key and its signing key. */
const offerIsIn = (index: CompanyVaultKeyIndex, o: VaultKeysOffer): boolean =>
  index.committeeKeys.some((k) => low(k.tag) === low(o.keys.committeeKey.tag) && low(k.value) === low(o.keys.committeeKey.value))
  && index.readers.some((r) => low(r) === low(o.keys.recordsKey))
  && index.filers.some((f) => low(f) === low(o.entry.statement.signingKey));
const FILED = z.object({ version: z.number().int().min(1), message: z.unknown() }).strict();
const INDEX = z.object({
  accountId: z.string(), signerCount: z.number().int().min(0),
  committeeKeys: z.array(z.object({ tag: z.string(), value: z.string() }).strict()),
  readers: z.array(z.string()), filers: z.array(z.string()),
}).strict();

export const signerRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: SignerRouteStore;
  readonly records: () => CompanyRecordStore;
  readonly ledger: Pick<Ledger, 'status'> & Partial<Pick<Ledger, 'holdsSigner'>>;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
}): express.Router => {
  const router = express.Router();
  const json = express.json({ limit: '2mb' });
  const personOf = (req: express.Request): unknown => (req as { userId?: unknown }).userId;
  const fileRoster = (req: express.Request, company: string, filed: z.infer<typeof FILED>): Promise<FilingAnswer> =>
    fileCompanyRecord({ records: deps.records(), accountOf: (a) => deps.store.getAccount(a), directoryOf: deps.directoryOf },
      personOf(req), { company, kind: 'roster', id: ROSTER_ID }, filed.version, filed.message);
  const holds = async (accountId: string, seat: string): Promise<boolean | null> => {
    try {
      return typeof deps.ledger.holdsSigner === 'function' ? await deps.ledger.holdsSigner(accountId, seat as never) : null;
    } catch {
      return null;
    }
  };

  /*
   * **A NEW SIGNER'S VAULT KEYS, OFFERED.** Kept only when the directory entry
   * their own wallet signed verifies for this company, names the signing key the
   * keys are signed with and the records key they give, and is for a seat the
   * account holds now; and only for the person whose own entry names that seat:
   * not for a person the directory already believes at another seat, nor for a
   * seat the directory believes is another person's. One offer per seat, which
   * only the person who made it replaces.
   */
  router.put('/api/accounts/:id/vault-keys', deps.signedIn, deps.member, json, async (req, res) => {
    const b = z.object({ offer: z.unknown() }).strict().safeParse(req.body ?? {});
    if (!b.success) {
      res.status(400).json({ error: 'this is not an offer of a signer\'s vault keys. Vault keys are offered with the directory entry your own wallet signed, and never with a key that opens the company.' });
      return;
    }
    const company = String(req.params.id);
    const account = deps.store.getAccount(company)!;
    const label = account.companyLabel ?? null;
    const address = readAccountAddress(account.contractAddress ?? null);
    if (label === null || address === null) {
      res.status(409).json({ error: 'this company has no account on the chain that a wallet could sign for, so no vault keys are taken. Nothing was kept.' });
      return;
    }
    const offer = { ...(b.data.offer as VaultKeysOffer), person: String(personOf(req)) };
    const why = vaultKeysOfferRefusal(label as CompanyLabel, address, company, offer);
    if (why !== null) { res.status(403).json({ refused: 'not-your-keys', error: `these vault keys are not kept: ${why}. Nothing was kept.` }); return; }
    const seat = String(offer.entry.statement.seat).toLowerCase();
    const person = String(personOf(req));
    const open = deps.store.vaultKeysOffersOf(company).find((o) => low(o.entry.statement.seat) === seat) ?? null;
    if (open !== null && open.person !== person) {
      res.status(409).json({ refused: 'not-your-seat', error: 'another person has offered vault keys for this seat, and only they replace them. Nothing was kept. If this seat is yours, ask the company\'s signers to check who holds it.' });
      return;
    }
    let directory: DirectoryNow;
    try {
      directory = await deps.directoryOf(company);
    } catch (e) {
      res.status(503).json({ error: `whose seat this is could not be read, so your vault keys are not kept yet: ${(e as Error)?.message ?? String(e)}. Nothing was kept. Try again.` });
      return;
    }
    const entered = directory.dir.seats.find((x) => x.seat === seat) ?? null;
    if ((entered !== null && entered.person !== person) || directory.dir.seats.some((x) => x.person === person && x.seat !== seat)) {
      res.status(403).json({ refused: 'not-your-seat', error: 'the company\'s directory names another person at this seat, or names you at another seat, so these vault keys are not kept for it. Nothing was kept.' });
      return;
    }
    const held = await holds(company, seat);
    if (held !== true) {
      res.status(held === null ? 503 : 409).json({ refused: 'not-seated', error: held === null
        ? 'whether the company\'s account holds your seat could not be read, so your vault keys are not kept yet. Nothing was kept. Try again.'
        : 'the company\'s account does not hold the seat these vault keys are for, so they are not kept. Nothing was kept.' });
      return;
    }
    deps.store.putVaultKeysOffer(company, seat, offerAsKept(offer));
    res.status(201).json({ offered: true });
  });

  /* **THE VAULT KEYS OFFERED AND NOT YET FOLDED IN**, for a seat's device to check and fold into the roster. */
  router.get('/api/accounts/:id/vault-keys/offers', deps.signedIn, deps.member, (req, res) => {
    res.status(200).json({ offers: deps.store.vaultKeysOffersOf(String(req.params.id)) });
  });

  /*
   * **THE ROSTER, FILED BY A SEAT THE COMPANY BELIEVES**, with the offers it
   * folded in and the index of the company's vault keys it makes. Check S
   * decides who may file it: a seat whose wallet the company's committee does
   * not hold yet cannot. With the filing go, of the offers it says it folded,
   * only those whose keys the filing's index holds: every other offer stays
   * open, for its own signer to replace or the next fold to take.
   */
  router.post('/api/accounts/:id/roster', deps.signedIn, deps.member, json, async (req, res) => {
    const b = z.object({
      roster: FILED, folded: z.array(z.string().regex(HEX64)), index: INDEX,
    }).strict().safeParse(req.body ?? {});
    const company = String(req.params.id);
    if (!b.success || b.data.index.accountId !== company) {
      res.status(400).json({ error: 'this is not a roster to file, with the offers it folds in and its index. Nothing was filed.' });
      return;
    }
    const answer = await fileRoster(req, company, b.data.roster);
    if (answer.status === 201) {
      const index = b.data.index as CompanyVaultKeyIndex;
      const held = new Set(deps.store.vaultKeysOffersOf(company)
        .filter((o) => b.data.folded.includes(String(o.entry.statement.seat).toLowerCase()) && offerIsIn(index, o))
        .map((o) => String(o.entry.statement.seat).toLowerCase()));
      deps.store.dropVaultKeysOffers(company, [...held]);
      deps.store.putVaultKeyIndex(index);
    }
    res.status(answer.status).json(answer.body);
  });

  /*
   * **A SIGNER ADMITTED, ONCE THE CHAIN HOLDS THEIR SEAT.** The admitting
   * seat's device checked who is waiting, files the roster with them in it, and
   * wraps the company's key to the key they gave; this keeps in plain text that
   * they are a member, their wrapped key, and how many signers the chain seats,
   * and lets their seat request go.
   */
  router.post('/api/accounts/:id/signers/:signerId/admit', deps.signedIn, deps.member, json, async (req, res) => {
    const b = z.object({
      roster: FILED, leaf: z.string().regex(HEX64), index: INDEX,
      wrap: z.object({ ephemeral: z.string().regex(HEX64), iv: z.string(), tag: z.string(), body: z.string() }).strict(),
    }).strict().safeParse(req.body ?? {});
    const company = String(req.params.id);
    const signerId = String(req.params.signerId);
    if (!b.success || b.data.index.accountId !== company) {
      res.status(400).json({ error: 'this is not an admission: the roster, the seat the chain holds, and the company\'s key wrapped to them. Nothing was filed.' });
      return;
    }
    const before = deps.store.getAccount(company)!;
    if (!before.pendingSigners.some((p) => p.id === signerId)) {
      res.status(409).json({ refused: 'not-waiting', error: 'that person is not waiting for a seat on this company. Reload the page. Nothing was filed.' });
      return;
    }
    const held = await holds(company, b.data.leaf);
    if (held !== true) {
      res.status(held === null ? 503 : 409).json({ refused: 'not-seated', error: held === null
        ? 'whether the chain holds this seat could not be read, so nobody was admitted. Nothing was filed. Try again.'
        : 'the chain does not hold this seat yet, so nobody was admitted. Nothing was filed. Try again once it shows it.' });
      return;
    }
    const answer = await fileRoster(req, company, b.data.roster);
    if (answer.status === 201) {
      const now = deps.store.getAccount(company)!;
      const waiting = now.pendingSigners.find((p) => p.id === signerId);
      let seated: number | null = null;
      try { seated = (await deps.ledger.status(company))?.signerCount ?? null; } catch { seated = null; }
      const fresh = deps.store.getAccount(company)!;
      deps.store.putAccount({
        ...fresh,
        pendingSigners: fresh.pendingSigners.filter((p) => p.id !== signerId),
        wrappedKeys: [...fresh.wrappedKeys.filter((w) => w.signerId !== signerId), { signerId, ...b.data.wrap }],
        memberUserIds: waiting?.userId && !fresh.memberUserIds.includes(waiting.userId) ? [...fresh.memberUserIds, waiting.userId] : fresh.memberUserIds,
        signerCount: seated ?? fresh.signerCount + 1,
      });
      deps.store.putVaultKeyIndex(b.data.index as CompanyVaultKeyIndex);
    }
    res.status(answer.status).json(answer.body);
  });

  return router;
};
