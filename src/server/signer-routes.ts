/**
 * **A COMPANY'S SIGNERS ON THE PRODUCT'S SERVER: ITS ROSTER FILED BY ITS SEATS'
 * DEVICES, AND NOTHING HERE OPENS IT.**
 *
 * The roster - who holds a seat, their keys, their leaf, their vault keys - is
 * one of the company's own records, sealed and signed on a seat's device. It
 * changes in three ways, each a route here, each filed through the one
 * company-record filing (`fileCompanyRecord`):
 *
 *   · **a signer admitted** once the chain holds their seat: the admitting
 *     seat's device files the roster with them in it and wraps the company's key
 *     to them; this keeps, in plain text, what the member gate needs.
 *   · **vault keys offered** by a new signer before they file the roster
 *     themselves: sealed under the company's roster key, with only the seat,
 *     the filing key and the records key beside it, kept for the person who
 *     made it - every person's own offer for a seat, none first come - and
 *     never read as the roster. No wallet key reaches this service in one.
 *   · **the roster filed** by a seat the company already believes, folding in
 *     the offers it checked against the roster it opened; an offer goes only
 *     once the index the filing makes holds its keys.
 */
import express from 'express';
import { z } from 'zod';
import type { Ledger } from '../core/ledger.js';
import type { SealedAccount } from '../core/types.js';
import { ROSTER_ID } from '../core/roster-record.js';
import { offerAsKept, type CompanyVaultKeyIndex, type VaultKeysOffer } from '../core/vault-keys.js';
import type { CompanyRecordStore } from '../midnight/sealed-record-wire.js';
import { fileCompanyRecord, type FilingAnswer } from './company-records-route.js';
import type { DirectoryNow } from './seat-directory-route.js';

export interface SignerRouteStore {
  getAccount(accountId: string): SealedAccount | null;
  putAccount(a: SealedAccount): void;
  putVaultKeyIndex(k: CompanyVaultKeyIndex): void;
  vaultKeysOffersOf(accountId: string): VaultKeysOffer[];
  putVaultKeysOffer(accountId: string, offer: VaultKeysOffer): void;
  dropVaultKeysOffers(accountId: string, offers: ReadonlyArray<Pick<VaultKeysOffer, 'seat' | 'person'>>): void;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const low = (h: unknown): string => String(h ?? '').toLowerCase();

/** Whether the index a roster filing makes holds an offer's keys: its records key and its signing key. */
const offerIsIn = (index: CompanyVaultKeyIndex, o: VaultKeysOffer): boolean =>
  index.readers.some((r) => low(r) === low(o.recordsKey))
  && index.filers.some((f) => low(f) === low(o.signingKey));
const FILED = z.object({ version: z.number().int().min(1), message: z.unknown() }).strict();
/* The index a roster filing makes: records keys and filing keys, and never a wallet key. */
const INDEX = z.object({
  accountId: z.string(), signerCount: z.number().int().min(0),
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
   * **A NEW SIGNER'S VAULT KEYS, OFFERED, AND KEPT SEALED.** The offer is
   * sealed under the company's roster key on the signer's device, so the
   * service holds no wallet key and checks only its shape; that the account
   * holds the seat now, read from the chain; and, once the directory holds an
   * entry for that seat, that this person filed one of them. Every person's
   * own offer for a seat is kept, each replaced only by them, so nobody's offer
   * keeps another's out. Whether an offer is true is each member's device's to
   * judge as it folds it in.
   */
  router.put('/api/accounts/:id/vault-keys', deps.signedIn, deps.member, json, async (req, res) => {
    const b = z.object({ offer: z.unknown() }).strict().safeParse(req.body ?? {});
    const person = String(personOf(req));
    const offer = b.success ? offerAsKept(b.data.offer, person) : null;
    if (offer === null) {
      res.status(400).json({ error: 'this is not an offer of a signer\'s vault keys. Vault keys are offered sealed under the company\'s roster key, with the seat and the filing and records keys beside them, and never with a key that opens the company. Nothing was kept.' });
      return;
    }
    const company = String(req.params.id);
    const seat = offer.seat;
    let directory: DirectoryNow;
    try {
      directory = await deps.directoryOf(company);
    } catch (e) {
      res.status(503).json({ error: `whose seat this is could not be read, so your vault keys are not kept yet: ${(e as Error)?.message ?? String(e)}. Nothing was kept. Try again.` });
      return;
    }
    /*
     * Kept for any entry this person filed for the seat. The service keeps every entry for a seat and judges none, so it
     * never takes the first as the seat's holder: an entry another member filed first keeps nobody's keys out, and an
     * entry a person filed on another seat says nothing of this one.
     */
    const forThisSeat = directory.dir.seats.filter((x) => x.seat === seat);
    if (forThisSeat.length > 0 && !forThisSeat.some((x) => x.person === person)) {
      res.status(403).json({ refused: 'not-your-seat', error: 'the company\'s directory holds no entry of yours for this seat, so these vault keys are not kept for it. Nothing was kept.' });
      return;
    }
    const held = await holds(company, seat);
    if (held !== true) {
      res.status(held === null ? 503 : 409).json({ refused: 'not-seated', error: held === null
        ? 'whether the company\'s account holds your seat could not be read, so your vault keys are not kept yet. Nothing was kept. Try again.'
        : 'the company\'s account does not hold the seat these vault keys are for, so they are not kept. Nothing was kept.' });
      return;
    }
    deps.store.putVaultKeysOffer(company, offer);
    res.status(201).json({ offered: true });
  });

  /* **THE VAULT KEYS OFFERED AND NOT YET FOLDED IN**, for a seat's device to check and fold into the roster. */
  router.get('/api/accounts/:id/vault-keys/offers', deps.signedIn, deps.member, (req, res) => {
    res.status(200).json({ offers: deps.store.vaultKeysOffersOf(String(req.params.id)) });
  });

  /*
   * **THE ROSTER, FILED BY A SEAT THE COMPANY BELIEVES**, with the offers it
   * folded in and the index of the company's vault keys it makes. It is kept
   * as every company record is (`fileCompanyRecord`): from the signed-in
   * person's own seat, held by the account now; whether that seat's role may
   * file a roster is each member's device's to judge. With the filing go, of
   * the offers for the seats it says it folded, only those whose records key and
   * filing key the filing's index holds: every other offer stays open, for its
   * own signer to replace or the next fold to take.
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
      deps.store.dropVaultKeysOffers(company, deps.store.vaultKeysOffersOf(company)
        .filter((o) => b.data.folded.includes(o.seat.toLowerCase()) && offerIsIn(index, o)));
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
