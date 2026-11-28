import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEAT_REFUSALS } from './refusal-codes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLET_EN = JSON.parse(readFileSync(resolve(HERE, '../../../wallet/src/locales/en.json'), 'utf8')) as Record<
  string,
  string
>;

/* The stops the wallet makes before anything is built, because it keeps no account, another account or two accounts as
 * the company's, could not look the person's companies up, or holds a seat the recovery words do not make. */
const KEPT_ACCOUNT_STOPS = ['no-pin', 'pinned-elsewhere', 'label-clash', 'registry-unread', 'seat-not-yours'] as const;
/* The acts whose pages turn every seat stop into their own seat words. */
const ACTS = ['choose-company-service', 'set-recovery-window', 'grant-read', 'change-role'] as const;

describe('a stop for the account the wallet keeps', () => {
  /* RED WHEN: a page tells such a stop as an unknown one, which it words as "part may have gone through". */
  it('is a seat stop on every page that words seat stops, for every act the wallet stops with it', () => {
    for (const code of KEPT_ACCOUNT_STOPS) {
      expect(SEAT_REFUSALS as readonly string[], code).toContain(code);
      for (const act of ACTS) expect(WALLET_EN[`act.${act}.why.${code}`], `${act} ${code}`).toBeTruthy();
    }
  });
});
