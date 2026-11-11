/**
 * **AN OFFER OF VAULT KEYS IS FOLDED INTO THE ROSTER, AND ONE THE FOLD REFUSES IS NAMED**, over the real routes and
 * the real fold a seat's upkeep runs. The founding seat's offer is folded, so the roster then holds its vault keys; an
 * offer from a seat the roster does not hold is refused and handed back with its seat and why, never dropped.
 */
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { toHex, type Hex } from '../core/crypto.js';
import { sealAccount } from '../core/account.js';
import type { Account } from '../core/types.js';
import { openRoster } from '../core/roster-record.js';
import { offerVaultKeysHere } from 'vaults-web-shared/roster-here.js';
import { rosterFollowed } from 'vaults-web-shared/vault-keys-given.js';
import { signerRoutes } from './signer-routes.js';
import { aCompanyOfTwoSeats, acmeReads, ADA, ADDRESS, apiAs, BO, CO, KEY, LABEL, store, type Seat } from './a-company-of-two-seats.test-support.js';

const KEYS = { epoch: 0, newest: 0, key: KEY as Hex, keyAt: () => KEY as Hex, sealing: () => ({ key: KEY as Hex, epoch: 0 }) };
let followed: Awaited<ReturnType<typeof rosterFollowed>> | Error | null = null;

const offerFrom = (seat: Seat, signerId: string) => offerVaultKeysHere(apiAs(seat.person), CO, {
  signerId, signingSecret: seat.signingSecret as Hex, committeeKey: seat.committeeKey as never,
  companyKey: toHex(new Uint8Array(32).fill(seat.n + 100)) as Hex,
  recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(seat.n)), LABEL, ADDRESS, new Uint8Array(32).fill(seat.n + 100), seat.seat),
  entry: seat.statement, viewingKey: KEY as Hex,
});

aCompanyOfTwoSeats((app, deps) => {
  app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
    const id = String(req.params.id);
    res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
  });
  app.use(signerRoutes({
    signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
    ledger: { status: async () => null, holdsSigner: async (_a, seat) => [ADA.seat, BO.seat].includes(String(seat)) },
  }));
}, {
  beforeTheAnchor: async () => {
    /* Acme's account with Ada's founding seat alone on its roster. */
    const signer = { id: 'sig_ada', leafCommitment: ADA.seat, userId: 'ada', name: 'ada', status: 'active', signingPublicKey: ADA.statement.signingKey, wrappingPublicKey: 'ab'.repeat(32), role: 'admin' };
    const account = {
      id: CO, name: 'Acme', createdAt: 'now', signers: [signer], policy: { threshold: 1 }, wrappedKeys: [],
      recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
    } as unknown as Account;
    store.putAccount({ ...sealAccount(account, KEY, [], 0), memberUserIds: ['ada', 'bo'] });
    await offerFrom(ADA, 'sig_ada');
    await offerFrom(BO, 'sig_bo');
    followed = await rosterFollowed({
      api: apiAs('ada'), accountId: CO, label: LABEL, account: ADDRESS, signingSecret: ADA.signingSecret as Hex,
      companyKeys: KEYS, reads: acmeReads, entered: ADA.entered,
    }).catch((e: unknown) => e as Error);
  },
});

describe('the fold a seat\'s upkeep runs over the open offers of vault keys', () => {
  /* RED WHEN: the upkeep follows the roster without folding the open offers, so no approver's vault keys reach it. */
  it('folds the founding seat\'s offer, so the roster then holds its vault keys', () => {
    expect(followed).not.toBeInstanceOf(Error);
    expect((followed as Exclude<typeof followed, Error | null>).changed).toBe(true);
    const ada = openRoster(store.newestRoster(CO)!, KEY as Hex).signers.find((s) => s.id === 'sig_ada');
    expect(ada?.vaultKeys?.committeeKey.value.toLowerCase()).toBe(String(ADA.committeeKey.value).toLowerCase());
  });

  /* RED WHEN: an offer the fold refuses is dropped, so the upkeep says done while that seat can sign for no vault. */
  it('hands back an offer from a seat the roster does not hold, with its seat and why', () => {
    const refused = (followed as Exclude<typeof followed, Error | null>).refused;
    expect(refused.map((r) => r.seat)).toEqual([BO.seat.toLowerCase()]);
    expect(refused[0]!.why).toMatch(/roster holds/u);
  });
});
