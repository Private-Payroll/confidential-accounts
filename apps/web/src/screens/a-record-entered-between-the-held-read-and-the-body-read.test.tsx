// @vitest-environment jsdom
/*
 * A seat enters a newer version of a record between the page's held read and its read of the record's body, on the page's own
 * view and its own judge. The body is newer than the held answer, so the page judges it again once over a fresh held read and
 * draws the vault's name from the new version; a version the company's records still do not name is refused after that one
 * fresh read. Each case names vaults of its own, so each runs alone and in any order. A second refusal in a row is held at the
 * store, by packages/web-shared/src/a-body-newer-than-the-held-answer-is-judged-again.test.ts (the view lets go of its held
 * answer only once: letGo [true, false]), and the page's stores judge through the same judgedOnce.
 */
import { aCompanyOf, beforeTheCall, openScreen } from './company-harness.test-support.js';
import { describe, expect, it } from 'vitest';
import { fileVaultInfoHere } from 'vaults-web-shared/vault-info-filed-here.js';
import { vaultInfoRecordsFor } from 'vaults-web-shared/vault-info-here.js';
import { judgeIn } from 'vaults-web-shared/vault-page-doors.js';
import { storeReachOver } from '../../../../src/testing/writes-over-a-send.js';
import type { Hex } from '../../../../src/core/crypto.js';
import {
  ADA,
  CO,
  KEY,
  directoryOf,
  sendAs
} from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { readsOf } from './screen-counts.test-support.js';
/* The service's test supports type a request by the signed-in person; this file's typecheck does not reach them otherwise. */
import type {} from '../../../../src/server/signed-in-request.js';

const company = aCompanyOf({ people: 2, vendors: 1, vaults: 3, proposals: 1 });
const FOUNDER = company.seats()[0]!.person;
const VAULT_NAMES = `/api/accounts/${company.fields.record}/records/read`;

/* The versions of each vault's name that this file has filed: a vault's name starts at version 1, and each filing here is made over the version before it. */
const filed = new Map<number, number>();
/* The founding seat names a vault again as the product files it, over the version this file last filed for it: entered in the company's records or, when `enters` is false, filed and left unentered. */
const named = (name: string, enters: boolean, which: number) => async (): Promise<void> => {
  const over = filed.get(which) ?? 1;
  filed.set(which, over + 1);
  const entered = enters ? ADA.entered : ({ enter: async () => {} } as unknown as typeof ADA.entered);
  await fileVaultInfoHere(
    {
      accountId: CO,
      companyKeys: KEY as never,
      signingSecret: ADA.signingSecret as Hex,
      directory: directoryOf(ADA),
      entered,
      records: vaultInfoRecordsFor(
        CO,
        ADA.signingSecret as Hex,
        async (asked) => judgeIn(await directoryOf(ADA)(asked)),
        storeReachOver((path, init) => sendAs(ADA.person)(path, init as never), CO)
      )
    },
    { vault: company.vaults()[which]!, name, description: '', over }
  );
};
/* What `after` read that `before` did not, by name: a read of the company's held answer is all of these, once. */
const readMore = (
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>
): Record<string, number> =>
  Object.fromEntries(
    Object.keys({ ...before, ...after })
      .map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)] as const)
      .filter(([, n]) => n !== 0)
  );
/* The reads that make held afresh: the directory, the chain's head and the company's roster, the newest versions and what each entry is proved by. */
const HELD_ONCE_MORE = {
  'route GET /api/accounts/:record/directory': 1,
  'route POST /api/accounts/:record/manifest/newest': 1,
  'route GET /api/accounts/:record/manifest/tree/pending': 1,
  'route POST /api/accounts/:record/manifest/tree/proofs': 1,
  'indexer invitedSeats': 1,
  'onChain anchorsOnChain': 1
};

describe(
  "A VAULT'S NEW NAME, ENTERED BETWEEN THE PAGE'S HELD READ AND ITS READ OF THE NAME",
  { timeout: 150_000 },
  () => {
    it('is drawn from the new version once the page has read held afresh, and held is read afresh once for it', async () => {
      await openScreen(company, FOUNDER, 'vaults');
      const before = await openScreen(company, FOUNDER, 'vaults');
      expect(before.text).toContain('Vault 0');
      beforeTheCall('POST', VAULT_NAMES, named('Renamed vault', true, 0), 'vault-info');
      const after = await openScreen(company, FOUNDER, 'vaults');
      /* RED WHEN: a name entered after the held read is refused, where a fresh held read names it (the page's judge passes no way to read held again). */
      expect(after.text).toContain('Renamed vault');
      expect(after.text).not.toContain('Vault 0');
      /* RED WHEN: held is read afresh more than once for it, or not at all. */
      expect(readMore(readsOf(before), readsOf(after))).toEqual(HELD_ONCE_MORE);
    });

    it('is refused when the fresh held read does not name it either, and one fresh held read serves the refusals read side by side', async () => {
      await openScreen(company, FOUNDER, 'vaults');
      const before = await openScreen(company, FOUNDER, 'vaults');
      /* Two vaults' names are filed again and left unentered: both are refused in one read of the names, and one fresh held read serves both. */
      beforeTheCall(
        'POST',
        VAULT_NAMES,
        async () => {
          await named('Third name', false, 1)();
          await named('Fourth name', false, 2)();
        },
        'vault-info'
      );
      const after = await openScreen(company, FOUNDER, 'vaults');
      /* RED WHEN: a version no entry of the company's records names is drawn. */
      expect(after.text).not.toContain('Third name');
      expect(after.text).not.toContain('Fourth name');
      /* RED WHEN: the two refusals read side by side make held afresh more than once between them. */
      expect(readMore(readsOf(before), readsOf(after))).toEqual(HELD_ONCE_MORE);
    });
  }
);
