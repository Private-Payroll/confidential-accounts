/**
 * **A NEW SIGNER'S VAULT KEYS ARE OFFERED, AND FOLDED INTO THE ROSTER BY A
 * SEAT THE COMPANY ALREADY BELIEVES.** A signer whose wallet the company's
 * committee does not hold yet cannot file the roster, so their device offers
 * their signed vault keys to the service: one open offer per seat, kept only
 * when it verifies against the signing key their own wallet-signed directory
 * entry names, and never read as the roster. The next seat the company
 * believes to open the roster checks each offer against the roster it opened,
 * folds the good ones in and files it; the offers folded go with that filing.
 *
 * Over real HTTP: the routes of `signer-routes.ts` beside the directory and
 * record routes, with the devices' own `offerVaultKeysHere` and `foldOffersHere`.
 * Ada and Bo are seated and believed; Cy holds an entry in the directory, and
 * the chain does not hold his seat.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import { toHex, type Hex } from '../core/crypto.js';
import { openAccount, sealAccount } from '../core/account.js';
import { rosterVaultKeys, signVaultKeys, vaultKeyIndexOf } from '../core/vault-keys.js';
import type { Account, SealedAccount } from '../core/types.js';
import type { VaultKeysOffer } from '../core/vault-keys.js';
import type { ChainHolders } from '../midnight/seat-directory.js';
import { foldOffersHere, offerVaultKeysHere, type RosterDoors } from 'vaults-web-shared/roster-here.js';
import { sealRoster, signedFoundingRoster } from '../core/roster-record.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { signerRoutes } from './signer-routes.js';
import {
  aCompanyOfTwoSeats, acmeReads, ADA, ADDRESS, BO, chains, CO, KEY, LABEL, seatOf, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

const CY = seatOf('cy', 3);
const ID: Record<string, string> = { ada: 'sgn_ada', bo: 'sgn_bo', cy: 'sgn_cy' };
const seated = (seats: Seat[]): ChainHolders => ({ seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1 });

aCompanyOfTwoSeats((app, deps) => {
  /* The company as a page reads it: the account record, with its newest roster record beside it. */
  app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
    const id = String(req.params.id);
    res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
  });
  app.use(signerRoutes({
    signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
    /* The chain holds every seat the company's directory chain does. */
    ledger: { status: async () => null, holdsSigner: async (_a, seat) => (chains.get(CO)?.seats.seats ?? []).includes(String(seat)) },
  }));
});

/** Acme's account, and its first roster, filed by Ada's founding seat: Ada, Bo and Cy, each under the filing key their wallet's entry names. */
beforeAll(async () => {
  const signer = (s: Seat) => ({
    id: ID[s.person]!, leafCommitment: s.seat as Hex, userId: s.person, name: s.person, status: 'active' as const,
    signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin' as const,
  });
  const account = {
    id: CO, name: 'Acme', createdAt: 'now', signers: [ADA, BO, CY].map(signer), policy: { threshold: 1 }, wrappedKeys: [],
    recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
  } as unknown as Account;
  store.putAccount(sealAccount(account, KEY, [], 0));
  /* Ada has given her vault keys: her own wallet's statement over her records key is in her entry, which is what her filings are believed by. */
  const adas = walletOf(ADA).recordsKey;
  const withAdasKeys = account.signers.map((x) => (x.id !== ID.ada ? x : {
    ...x, vaultKeys: signVaultKeys(CO, ID.ada!, {
      committeeKey: ADA.committeeKey as never, recordsKey: adas.recordsKey as Hex, recordsKeyStatement: adas.signature as Hex, recordsKeySeat: ADA.seat as Hex,
    }, ADA.signingSecret as Hex),
  }));
  expect(store.fileRoster(signedFoundingRoster(CO, { name: 'Acme', signers: withAdasKeys }, KEY, ADA.signingSecret as Hex))).toBeNull();
  /* Cy files his entry while the chain holds his seat, and then it holds it no longer. */
  chains.set(CO, seated([ADA, BO, CY]));
  expect((await sendAs('cy')(`/api/accounts/${CO}/directory/4`, { method: 'POST', body: JSON.stringify({ company: CO, version: 4, change: { kind: 'claim', entry: CY.entry } }) })).status).toBe(201);
  chains.set(CO, seated([ADA, BO]));
});

const api = (person: string) => async (path: string, init?: RequestInit) => {
  const r = await sendAs(person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
  if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status, body: r.body });
  return r.body;
};
/** One seat's device, reading and filing the roster under the filing key its entry names. */
const deviceOf = (s: Seat): RosterDoors => ({
  api: api(s.person), accountId: CO, viewingKey: KEY, signingSecret: s.signingSecret as Hex, label: LABEL, account: ADDRESS,
  reads: acmeReads,
});
/** What a seat's wallet released for this company, and the statement it signed over the records key. */
const walletOf = (s: Seat) => ({
  companyKey: toHex(new Uint8Array(32).fill(s.n + 100)),
  recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat),
});
const offer = (s: Seat, o: { signingSecret?: Hex; signerId?: string } = {}) => offerVaultKeysHere(api(s.person), CO, {
  signerId: o.signerId ?? ID[s.person]!, signingSecret: o.signingSecret ?? s.signingSecret as Hex, committeeKey: s.committeeKey as never,
  ...walletOf(s), companyKey: walletOf(s).companyKey as Hex, entry: s.statement,
});
const offers = async () => ((await api('ada')(`/api/accounts/${CO}/vault-keys/offers`)) as { offers: Array<{ signerId: string; person: string }> }).offers;
const rosterNow = async () => {
  const rec = await api('ada')(`/api/accounts/${CO}`) as SealedAccount & { roster?: { version: number } | null };
  return { account: openAccount(rec as never, KEY), version: rec.roster?.version ?? 0 };
};
const keysOf = async (s: Seat) => rosterVaultKeys((await rosterNow()).account).find((r) => r.signerId === ID[s.person])!.keys;

describe('A NEW SIGNER\'S VAULT KEYS, OFFERED', () => {
  it('AN OFFER SIGNED BY A DIFFERENT KEY THAN THE ONE THE SEAT\'S OWN DIRECTORY ENTRY NAMES IS REFUSED, AND NOTHING IS KEPT', async () => {
    /* Bo's entry and wallet, with the keys signed by Ada's filing key. */
    const refused = await offer(BO, { signingSecret: ADA.signingSecret as Hex }).catch((e) => e);
    /* RED WHEN: the service keeps an offer whose signature it did not hold to the signing key in that seat's own entry. */
    expect(refused.status).toBe(403);
    expect(refused.body.refused).toBe('not-your-keys');
    expect(await offers()).toEqual([]);
    /* RED WHEN: the old body - the viewing key beside the keys, for the service to write into the roster - is taken. */
    const old = await sendAs('bo')(`/api/accounts/${CO}/vault-keys`, { method: 'PUT', body: JSON.stringify({
      viewingKey: KEY, committeeKey: BO.committeeKey, recordsKey: 'ab'.repeat(32), signature: 'ab'.repeat(64) }) } as never);
    expect(old.status).toBe(400);
    /* RED WHEN: an offer for a seat the chain does not hold is kept. */
    const unheld = await offer(CY).catch((e) => e);
    expect(unheld.status).toBe(409);
    expect(await offers()).toEqual([]);
  });

  it('ONE OFFER IS KEPT PER SEAT, A NEW ONE REPLACING THE OLD, AND IT IS NOT READ AS THE ROSTER', async () => {
    /* An offer carrying a field beside the ones an offer has: checked, and kept without it. */
    const extra = { ...walletOf(BO) };
    await offerVaultKeysHere(async (path, init) => {
      const body = JSON.parse(String(init?.body)) as { offer: Record<string, unknown> };
      return api('bo')(path, { ...init, body: JSON.stringify({ offer: { ...body.offer, note: 'a secret a page should never send' } }) });
    }, CO, { signerId: ID.bo!, signingSecret: BO.signingSecret as Hex, committeeKey: BO.committeeKey as never, entry: BO.statement, ...extra, companyKey: extra.companyKey as Hex });
    /* RED WHEN: whatever else a client sends with an offer is kept and handed to every member. */
    expect(JSON.stringify(await offers())).not.toContain('a secret a page should never send');
    await offer(BO);
    await offer(BO);
    /* RED WHEN: a seat's offers pile up, or the service attributes one to anybody but who is signed in. */
    expect((await offers()).map((o) => `${o.signerId} ${o.person}`)).toEqual([`${ID.bo} bo`]);
    /* RED WHEN: an offer is written into the roster, or counted as a signer's keys, before a believed seat folds it. */
    expect(await keysOf(BO)).toBeNull();
  });
});

describe('OFFERS, FOLDED BY A SEAT THE COMPANY BELIEVES', () => {
  it('A FOLD BY A SEAT THE COMPANY DOES NOT BELIEVE IS REFUSED, AND THE OFFER STAYS OPEN', async () => {
    const before = await rosterNow();
    /* RED WHEN: a seat whose wallet the chain does not hold files the roster with the offers in it. */
    const refused = await foldOffersHere(deviceOf(CY)).catch((e) => e);
    expect([refused.status, refused.body?.refused]).toEqual([403, 'not-on-the-committee']);
    expect((await rosterNow()).version).toBe(before.version);
    expect(await keysOf(BO)).toBeNull();
    expect(await offers()).toHaveLength(1);
  });

  it('A GOOD OFFER FOLDS INTO THE ROSTER AS ITS SIGNER SIGNED IT, AND THE OFFER IS GONE WITH THAT FILING', async () => {
    const folded = await foldOffersHere(deviceOf(ADA));
    expect(folded).toEqual({ folded: [BO.seat], refused: [] });
    /* RED WHEN: a folded offer is left open, to be folded again or read as still waiting. */
    expect(await offers()).toEqual([]);
    /* RED WHEN: the keys folded are not the ones Bo's device signed, or land in anybody else's entry. */
    const kept = await keysOf(BO);
    expect(kept?.committeeKey).toEqual(BO.committeeKey);
    expect(kept?.recordsKeySeat).toBe(BO.seat);
    expect((await keysOf(ADA))?.committeeKey).toEqual(ADA.committeeKey);
    /* The roster's next version is a record Ada's seat filed, and the index of the company's vault keys is the one made from it. */
    expect((await rosterNow()).version).toBe(2);
    /* Bo's entry keeps the directory entry his own wallet signed, beside his keys. */
    const bo = (await rosterNow()).account.signers.find((x) => x.id === ID.bo)!;
    expect(bo.directoryEntry?.statement).toEqual(BO.statement);
    expect(store.getVaultKeyIndex(CO)!.committeeKeys).toEqual([ADA.committeeKey, BO.committeeKey].sort((a, b) => (a.value < b.value ? -1 : 1)));
  });

  it('AN OFFER THAT DOES NOT MATCH THE ROSTER IS REFUSED, NEVER FOLDED, AND STAYS OPEN UNTIL ITS OWN SIGNER OFFERS AGAIN', async () => {
    const before = (await rosterNow()).version;
    /* Bo's wallet and filing key, offered for Ada's roster entry: the service can check only the entry, the device the roster. */
    await offer(BO, { signerId: ID.ada });
    expect(await offers()).toHaveLength(1);
    const folded = await foldOffersHere(deviceOf(ADA));
    /* RED WHEN: a device folds an offer whose own entry is not for the seat and signing key the roster holds for that signer. */
    expect(folded.folded).toEqual([]);
    expect(folded.refused.map((r) => r.seat)).toEqual([BO.seat]);
    expect((await keysOf(ADA))?.committeeKey).toEqual(ADA.committeeKey);
    /* RED WHEN: an offer a fold refused is let go, so any believed filer could drop any signer's open offer. */
    expect((await offers()).map((o) => `${o.signerId} ${o.person}`)).toEqual([`${ID.ada} bo`]);
    /* Nothing was folded, so nothing was filed. */
    expect((await rosterNow()).version).toBe(before);
    /* Ada's own wallet and filing key, with an entry naming Bo's seat: the service keeps no offer for a seat that is not hers. */
    const identity = identityFromSecret(new Uint8Array(32).fill(ADA.n));
    const elsewhere = signDirectoryEntry(identity, LABEL, ADDRESS, new Uint8Array(32).fill(ADA.n + 100), ADA.statement.signingKey, BO.seat);
    const notHers = await offerVaultKeysHere(api('ada'), CO, {
      signerId: ID.ada!, signingSecret: ADA.signingSecret as Hex, committeeKey: ADA.committeeKey as never, entry: elsewhere,
      companyKey: walletOf(ADA).companyKey as Hex,
      recordsKey: signRecordsKey(identity, LABEL, ADDRESS, new Uint8Array(32).fill(ADA.n + 100), BO.seat),
    }).catch((e) => e);
    /* RED WHEN: one member's offer replaces the open offer for another member's seat. */
    expect([notHers.status, notHers.body?.refused]).toEqual([409, 'not-your-seat']);
    /* Ada's own wallet signs an entry for her own seat naming Bo's filing key, and the keys are signed with it: the service holds them to that entry and keeps them. */
    const lent = signDirectoryEntry(identity, LABEL, ADDRESS, new Uint8Array(32).fill(ADA.n + 100), BO.statement.signingKey, ADA.seat);
    await offerVaultKeysHere(api('ada'), CO, {
      signerId: ID.ada!, signingSecret: BO.signingSecret as Hex, committeeKey: ADA.committeeKey as never, entry: lent,
      companyKey: walletOf(ADA).companyKey as Hex, recordsKey: walletOf(ADA).recordsKey,
    });
    /* RED WHEN: a device folds keys not signed by the signing key the roster keeps for that signer, or an entry for another seat. */
    const both = await foldOffersHere(deviceOf(ADA));
    expect(both.folded).toEqual([]);
    expect(both.refused.map((r) => r.seat).sort()).toEqual([ADA.seat, BO.seat].sort());
    expect((await keysOf(ADA))?.committeeKey).toEqual(ADA.committeeKey);
    expect((await offers()).map((o) => o.person).sort()).toEqual(['ada', 'bo']);
    expect((await rosterNow()).version).toBe(before);
    /* Each signer offers again, from their own entry: the keys the roster already holds, folded, and both offers let go with that filing. */
    await offer(BO);
    await offer(ADA);
    expect([...(await foldOffersHere(deviceOf(ADA))).folded].sort()).toEqual([ADA.seat, BO.seat].sort());
    expect(await offers()).toEqual([]);
    expect((await rosterNow()).version).toBe(before + 1);
  });

  it('AN OFFER IS KEPT ONLY FOR THE PERSON WHOSE OWN ENTRY NAMES ITS SEAT, AND ONLY THEY REPLACE IT', async () => {
    /* Ada's own wallet signs an entry for Bo's seat under her own filing key: the directory names Bo there. */
    const identity = identityFromSecret(new Uint8Array(32).fill(ADA.n));
    const forBosSeat = signDirectoryEntry(identity, LABEL, ADDRESS, new Uint8Array(32).fill(ADA.n + 100), ADA.statement.signingKey, BO.seat);
    const squat = await offerVaultKeysHere(api('ada'), CO, {
      signerId: ID.bo!, signingSecret: ADA.signingSecret as Hex, committeeKey: ADA.committeeKey as never, entry: forBosSeat,
      companyKey: walletOf(ADA).companyKey as Hex,
      recordsKey: signRecordsKey(identity, LABEL, ADDRESS, new Uint8Array(32).fill(ADA.n + 100), BO.seat),
    }).catch((e) => e);
    /* RED WHEN: a member is kept an offer for a seat the directory names as another person's, with no open offer in the way. */
    expect([squat.status, squat.body?.refused]).toEqual([403, 'not-your-seat']);
    expect(await offers()).toEqual([]);
    /* Bo's offer is open; Bo replaces it himself, and nobody else does. */
    await offer(BO);
    const replaced = await sendAs('ada')(`/api/accounts/${CO}/vault-keys`, {
      method: 'PUT', body: JSON.stringify({ offer: (await offers())[0] }),
    } as never);
    /* RED WHEN: another member's copy of Bo's own offer replaces it, and is attributed to them. */
    expect([replaced.status, (replaced.body as { refused?: string }).refused]).toEqual([409, 'not-your-seat']);
    expect((await offers()).map((o) => o.person)).toEqual(['bo']);
    await offer(BO);
    expect((await offers()).map((o) => o.person)).toEqual(['bo']);
    await foldOffersHere(deviceOf(ADA));
    expect(await offers()).toEqual([]);
  });

  it('AN OFFER A FILING SAYS IT FOLDED IS LET GO ONLY WHEN THE FILING\'S INDEX HOLDS ITS KEYS', async () => {
    /* Bo offers again the keys the roster already holds for him: a waiting slot, open until a filing that holds them. */
    await offer(BO);
    expect(await offers()).toHaveLength(1);
    const now = await rosterNow();
    const file = async (index: ReturnType<typeof vaultKeyIndexOf>) => {
      const version = store.newestRoster(CO)!.version + 1;
      const rec = signCompanyFiling(sealRoster(CO, { name: 'Acme', signers: now.account.signers }, version, 0, KEY), ADA.signingSecret as Hex);
      const r = await sendAs('ada')(`/api/accounts/${CO}/roster`, {
        method: 'POST', body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [BO.seat], index }),
      });
      expect(r.status).toBe(201);
    };
    /* A filing that names Bo's offer as folded, with an index that does not hold his keys. */
    const held = vaultKeyIndexOf({ id: CO, signers: now.account.signers });
    await file({ ...held, committeeKeys: held.committeeKeys.filter((k) => k.value !== BO.committeeKey.value) });
    /* RED WHEN: the service lets go an offer the filing names but does not hold. */
    expect(await offers()).toHaveLength(1);
    await file(held);
    /* RED WHEN: an offer the filing holds is left open. */
    expect(await offers()).toEqual([]);
  });

  it('AN OFFER WHOSE OWN ENTRY IS FOR ANOTHER SEAT THAN THE ROSTER HOLDS FOR ITS SIGNER IS REFUSED BY THE SERVICE, AND BY A DEVICE IF THE SERVICE KEPT IT', async () => {
    /* Bo's own keys and records-key statement, beside an entry Bo's wallet signed for Ada's seat under his own filing key. */
    const identity = identityFromSecret(new Uint8Array(32).fill(BO.n));
    const forAda = signDirectoryEntry(identity, LABEL, ADDRESS, new Uint8Array(32).fill(BO.n + 100), BO.statement.signingKey, ADA.seat);
    const ask = {
      signerId: ID.bo!, signingSecret: BO.signingSecret as Hex, committeeKey: BO.committeeKey as never, entry: forAda,
      companyKey: walletOf(BO).companyKey as Hex, recordsKey: walletOf(BO).recordsKey,
    };
    const refused = await offerVaultKeysHere(api('bo'), CO, ask).catch((e) => e);
    /* RED WHEN: the service keeps an offer for a seat its directory names as another person's. */
    expect([refused.status, refused.body?.refused]).toEqual([403, 'not-your-seat']);
    expect(await offers()).toEqual([]);
    /* A service that kept it anyway: the device that folds holds it to the roster, which the service cannot change. */
    let sent: { offer: VaultKeysOffer } | null = null;
    await offerVaultKeysHere(async (_path, init) => { sent = JSON.parse(String(init?.body)); return {}; }, CO, ask);
    store.putVaultKeysOffer(CO, ADA.seat, { ...sent!.offer, person: 'bo' });
    /* RED WHEN: a device folds an offer whose own entry is not for the seat the roster holds for that signer, and keeps that entry as theirs. */
    expect((await foldOffersHere(deviceOf(ADA))).refused.map((r) => r.seat)).toEqual([ADA.seat]);
    const bo = (await rosterNow()).account.signers.find((x) => x.id === ID.bo)!;
    expect(bo.directoryEntry?.statement).toEqual(BO.statement);
    store.dropVaultKeysOffers(CO, [ADA.seat]);
  });

  it('AN OFFER IS NOT FOLDED INTO AN ENTRY THE DEVICE REFUSES FOR ANYTHING BUT A MISSING WITNESS, AND STAYS OPEN', async () => {
    /* Ada's seat files Bo's entry with rights the chain did not seat him with: every device refuses that entry. */
    const now = await rosterNow();
    const version = store.newestRoster(CO)!.version + 1;
    const signers = now.account.signers.map((x) => (x.id === ID.bo ? { ...x, rights: { mayApprove: false, everyVault: false, onVaults: [] } } : x));
    const rec = signCompanyFiling(sealRoster(CO, { name: 'Acme', signers }, version, 0, KEY), ADA.signingSecret as Hex);
    expect((await sendAs('ada')(`/api/accounts/${CO}/roster`, {
      method: 'POST', body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers }) }),
    })).status).toBe(201);
    await offer(BO);
    const folded = await foldOffersHere(deviceOf(ADA));
    /* RED WHEN: a device folds an offer into an entry it does not believe, and files that entry on as if it did. */
    expect(folded.folded).toEqual([]);
    expect(folded.refused.map((r) => r.seat)).toEqual([BO.seat]);
    expect((await offers()).map((o) => o.person)).toEqual(['bo']);
    expect(store.newestRoster(CO)!.version).toBe(version);
    /* Bo's vault keys rewritten by Ada's seat: his own honest offer would make the entry believed again, and is still not folded into it. */
    const adas = walletOf(ADA).recordsKey;
    const rewritten = now.account.signers.map((x) => (x.id === ID.bo ? { ...x, vaultKeys: signVaultKeys(CO, ID.bo!, {
      committeeKey: BO.committeeKey as never, recordsKey: adas.recordsKey as Hex, recordsKeyStatement: adas.signature as Hex, recordsKeySeat: BO.seat as Hex,
    }, ADA.signingSecret as Hex) } : x));
    const v2 = version + 1;
    const rec2 = signCompanyFiling(sealRoster(CO, { name: 'Acme', signers: rewritten }, v2, 0, KEY), ADA.signingSecret as Hex);
    expect((await sendAs('ada')(`/api/accounts/${CO}/roster`, {
      method: 'POST', body: JSON.stringify({ roster: { version: v2, message: toCompanyWire(rec2) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers: rewritten }) }),
    })).status).toBe(201);
    /* RED WHEN: a fold writes into an entry the device refuses for anything but the witness the offer brings. */
    expect((await foldOffersHere(deviceOf(ADA))).folded).toEqual([]);
    expect(store.newestRoster(CO)!.version).toBe(v2);
    /* The honest roster filed again, for the cases after this one. */
    const v3 = v2 + 1;
    const rec3 = signCompanyFiling(sealRoster(CO, { name: 'Acme', signers: now.account.signers }, v3, 0, KEY), ADA.signingSecret as Hex);
    expect((await sendAs('ada')(`/api/accounts/${CO}/roster`, {
      method: 'POST', body: JSON.stringify({ roster: { version: v3, message: toCompanyWire(rec3) }, folded: [BO.seat], index: vaultKeyIndexOf({ id: CO, signers: now.account.signers }) }),
    })).status).toBe(201);
    expect(await offers()).toEqual([]);
  });

  it('AN OFFER FOR A NEW SIGNER IS NOT FOLDED WHEN THE ENTRY IT WOULD MAKE IS NOT ONE THE DEVICE BELIEVES', async () => {
    /* Dee is admitted at a seat the chain holds; her wallet is on no committee yet, so only an offer can witness her entry. */
    const DEE = seatOf('dee', 4);
    const now = await rosterNow();
    const deeEntry = { ...now.account.signers.find((x) => x.id === ID.bo)!, id: 'sgn_dee', name: 'dee', userId: 'dee', leafCommitment: DEE.seat as Hex,
      signingPublicKey: DEE.statement.signingKey as Hex, vaultKeys: null, directoryEntry: null };
    const signers = [...now.account.signers, deeEntry];
    const version = store.newestRoster(CO)!.version + 1;
    const rec = signCompanyFiling(sealRoster(CO, { name: 'Acme', signers }, version, 0, KEY), ADA.signingSecret as Hex);
    chains.set(CO, seated([ADA, BO, DEE]));
    try {
      expect((await sendAs('ada')(`/api/accounts/${CO}/roster`, {
        method: 'POST', body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers }) }),
      })).status).toBe(201);
      /* An offer for Dee's seat signed by Bo's wallet, which already signed Bo's entry: a service that kept it, as one could. */
      const bos = identityFromSecret(new Uint8Array(32).fill(BO.n));
      const entry = signDirectoryEntry(bos, LABEL, ADDRESS, new Uint8Array(32).fill(BO.n + 100), DEE.statement.signingKey, DEE.seat);
      let sent: { offer: VaultKeysOffer } | null = null;
      await offerVaultKeysHere(async (_path, init) => { sent = JSON.parse(String(init?.body)); return {}; }, CO, {
        signerId: 'sgn_dee', signingSecret: DEE.signingSecret as Hex, committeeKey: BO.committeeKey as never, entry,
        companyKey: walletOf(BO).companyKey as Hex, recordsKey: signRecordsKey(bos, LABEL, ADDRESS, new Uint8Array(32).fill(BO.n + 100), DEE.seat),
      });
      store.putVaultKeysOffer(CO, DEE.seat, { ...sent!.offer, person: 'dee' });
      const folded = await foldOffersHere(deviceOf(ADA));
      /* RED WHEN: a fold makes an entry the device itself would refuse - one wallet behind two signers - and files it. */
      expect(folded.folded).toEqual([]);
      expect(folded.refused.map((r) => r.seat)).toEqual([DEE.seat]);
      expect(store.newestRoster(CO)!.version).toBe(version);
    } finally {
      store.dropVaultKeysOffers(CO, [DEE.seat]);
      chains.set(CO, seated([ADA, BO]));
    }
  });
});

