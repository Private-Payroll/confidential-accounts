/**
 * **A ROSTER FOLDED FROM THE FOUNDING DEVICE BEFORE THE COMPANY'S FIRST ANCHOR
 * GOES IN AFTER ITS FOUNDING RECORDS**, over the real routes. The founding
 * seat offers its vault keys and folds them into the roster before anything is
 * anchored, as a vault's creation does; the version filed is entered after the
 * company's first state and first roster, so its first anchor holds them below
 * it, and that anchor is made.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { toHex, type Hex } from '../core/crypto.js';
import { sealAccount } from '../core/account.js';
import type { Account } from '../core/types.js';
import { foldOffersHere, offerVaultKeysHere, type Folded, type RosterDoors } from 'vaults-web-shared/roster-here.js';
import { signerRoutes } from './signer-routes.js';
import { aCompanyOfTwoSeats, acmeReads, ADA, ADDRESS, apiAs, chains, CO, KEY, LABEL, store } from './a-company-of-two-seats.test-support.js';

/** What the manifest held, and what the fold came to, just before the first anchor. */
let before: { readonly entries: readonly string[]; readonly folded: Folded | Error } | null = null;
let outcome: { readonly anchored: number } | Error | null = null;

const adasDevice: RosterDoors = {
  api: apiAs('ada'), accountId: CO, viewingKey: KEY, signingSecret: ADA.signingSecret as Hex, label: LABEL, account: ADDRESS,
  reads: acmeReads, entered: ADA.entered,
};

aCompanyOfTwoSeats((app, deps) => {
  app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
    const id = String(req.params.id);
    res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
  });
  app.use(signerRoutes({
    signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
    ledger: { status: async () => null, holdsSigner: async (_a, seat) => String(seat) === ADA.seat },
  }));
}, {
  beforeTheAnchor: async () => {
    /* Acme's account sealed under its key, as a page opens it, with Ada's founding seat. */
    const signer = { id: 'sig_ada', leafCommitment: ADA.seat, userId: 'ada', name: 'ada', status: 'active', signingPublicKey: ADA.statement.signingKey, wrappingPublicKey: 'ab'.repeat(32), role: 'admin' };
    const account = {
      id: CO, name: 'Acme', createdAt: 'now', signers: [signer], policy: { threshold: 1 }, wrappedKeys: [],
      recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
    } as unknown as Account;
    store.putAccount({ ...sealAccount(account, KEY, [], 0), memberUserIds: ['ada', 'bo'] });
    await offerVaultKeysHere(apiAs('ada'), CO, {
      signerId: 'sig_ada', signingSecret: ADA.signingSecret as Hex, committeeKey: ADA.committeeKey as never,
      companyKey: toHex(new Uint8Array(32).fill(ADA.n + 100)) as Hex,
      recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(ADA.n)), LABEL, ADDRESS, new Uint8Array(32).fill(ADA.n + 100), ADA.seat),
      entry: ADA.statement, viewingKey: KEY as Hex,
    });
    const folded = await foldOffersHere(adasDevice).catch((e: unknown) => e as Error);
    before = { entries: store.manifestOf(CO).entries.map((e) => `${e.kind}@${e.version}`), folded };
  },
  anchored: (o) => { outcome = o; },
});

describe('A ROSTER FOLDED BEFORE THE FIRST ANCHOR', () => {
  it('is entered after the company\'s first state and first roster, and the first anchor holds all three', () => {
    expect(chains.has(CO)).toBe(true);
    expect(before!.folded).not.toBeInstanceOf(Error);
    /* RED WHEN: a roster folded before the first anchor is entered alone, leaving the founding roster below it for good. */
    expect(before!.entries).toEqual(['state@1', 'roster@1', 'roster@2']);
    expect(outcome).not.toBeInstanceOf(Error);
    const first = store.keptTreeOf(CO).headers[0]!;
    expect(first.changes.filter((c) => c.leaf.kind === 'roster').map((c) => c.leaf.version)).toEqual([1, 2]);
  });
});
