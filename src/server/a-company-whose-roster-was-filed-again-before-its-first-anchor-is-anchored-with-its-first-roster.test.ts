/**
 * **A COMPANY WHOSE ROSTER WAS FILED AGAIN BEFORE ITS FIRST ANCHOR.** Its first
 * roster was kept and never entered; its second and third were filed and
 * entered, then its directory, its first state and a proposal - and no anchor
 * landed. Its founding device still makes its first anchor, over the real
 * routes and the test's chain: the first roster entered late, below the later
 * versions, and anchored before them in the first batch, so every device
 * believes the seat that founded it.
 */
import { describe, expect, it } from 'vitest';
import { aCompanyOfTwoSeats, ACME_STATE, acmeDirectoryWithItsFold, ADA, CO, KEY, sendAs, store } from './a-company-of-two-seats.test-support.js';
import { foundedOnChainHere, FOUNDING_ASKED } from 'vaults-web-shared/vault-page-doors.js';
import { sealRoster } from '../core/roster-record.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry, directoryEntry, proposalEntry, signManifestEntry, type ManifestEntryBody } from '../midnight/record-manifest.js';
import { signProposalFiling } from '../core/proposal-filing.js';
import type { SealedProposal } from '../core/types.js';
import type { Hex } from '../core/crypto.js';

/** Acme's roster at `version`, as Ada's device seals and signs each: one seat, hers. */
const rosterAt = (version: number): SealedCompanyRecord => signCompanyFiling(sealRoster(CO, {
  name: 'Acme',
  signers: [{ id: 'sig_ada', leafCommitment: ADA.seat as Hex, userId: 'ada', name: 'ada', status: 'active', signingPublicKey: ADA.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin' } as never],
}, version, 0, KEY), ADA.signingSecret as Hex);
const FIRST = rosterAt(1);

const enteredByAda = async (bodies: readonly ManifestEntryBody[]) => {
  const r = await sendAs('ada')(`/api/accounts/${CO}/manifest/entries`, {
    method: 'POST', body: JSON.stringify({ entries: bodies.map((b) => signManifestEntry(CO, b, ADA.signingSecret as Hex)) }),
  });
  expect(r.status).toBe(201);
};

let outcome: { readonly anchored: number } | Error | null = null;

aCompanyOfTwoSeats(undefined, {
  roster: () => FIRST,
  /* As on the founding device that folded its vault keys twice before anchoring: roster 2 and 3 filed and entered, then the rest. */
  beforeTheAnchor: async () => {
    for (const v of [2, 3]) {
      const rec = rosterAt(v);
      expect(store.fileRoster(rec)).toBeNull();
      await enteredByAda([companyRecordEntry(rec)]);
    }
    await enteredByAda([directoryEntry(store.directoryFilingsOf(CO)[0]!)]);
    await enteredByAda([companyRecordEntry(ACME_STATE)]);
    const filing = signProposalFiling(CO, {
      id: 'prp_AieC3GEx_2Jv', digest: 'd1'.repeat(32) as Hex, chainId: 'c1'.repeat(32) as Hex, keyEpoch: 0,
      createdAt: '2026-10-20T18:03:28.101Z', sealed: { iv: 'aa', tag: 'bb', body: 'cc' },
    }, ADA.signingSecret as Hex);
    store.putProposal({
      id: filing.id, accountId: CO, status: 'open', createdAt: filing.createdAt, digest: filing.digest, chainId: filing.chainId,
      approvalCount: 0, keyEpoch: 0, sealed: filing.sealed, filedBy: filing.filedBy,
    } as SealedProposal);
    await enteredByAda([proposalEntry(CO, filing)]);
    expect(store.manifestOf(CO).entries.map((e) => `${e.kind}@${e.version}`)).toEqual(['roster@2', 'roster@3', 'directory@1', 'state@1', 'proposal@1']);
  },
  anchored: (o) => { outcome = o; },
});

describe('THE FOUNDING DEVICE ANCHORS A COMPANY WHOSE ROSTER WAS FILED AGAIN BEFORE ITS FIRST ANCHOR', () => {
  it('makes the first anchor, holding the first roster then the second then the third, and the first state', () => {
    /* RED WHEN: a company whose roster was filed again before its first anchor can never be anchored. */
    expect(outcome).not.toBeInstanceOf(Error);
    const first = store.keptTreeOf(CO).headers[0]!;
    /* RED WHEN: the first roster is left out of the first batch, which would leave the company with no founding seat for good. */
    expect(first.changes.filter((c) => c.leaf.kind === 'roster').map((c) => c.leaf.version)).toEqual([1, 2, 3]);
    expect(first.changes.some((c) => c.leaf.kind === 'state' && c.leaf.version === 1)).toBe(true);
    /* RED WHEN: entering the first roster late makes the service serve it as the newest. */
    expect(store.newestEntered(CO, 'company:roster:signers')).toBe(3);
  });

  it('is believed founded by its founding seat on every device', async () => {
    /* RED WHEN: a device reads the company's first anchor as not holding its first roster entered by its founding seat. */
    expect(foundedOnChainHere(await acmeDirectoryWithItsFold(FOUNDING_ASKED, [ADA]))).toBeNull();
  });
});
