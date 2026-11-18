import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPOSIT_CLOCKS_MAY_DIFFER_MS, DEPOSIT_TIME_TO_LIVE_MS } from '../../../../packages/web-shared/src/vault-private-deposit.js';

/*
 * A deposit that may still arrive holds its vault for the deposit's time to live and the allowance for clocks that
 * differ. Every sentence that tells a person how long that hold lasts says the same number of minutes, read here
 * from the two numbers the hold is made of, so the words cannot drift from the hold.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const HOLD_MINUTES = (DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS) / 60_000;

const words = (file: string): Record<string, string> => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Record<string, string>;
const minutesSaid = (text: string): number[] => [...text.matchAll(/(\d+) minutes/gu)].map((m) => Number(m[1]));

const HOLD_SENTENCES: readonly [string, readonly string[]][] = [
  ['apps/wallet/src/locales/en.json', ['act.private-deposit.shown.nothing-else', 'act.private-deposit.why.not-yet-seen']],
  ['apps/web/src/locales/pages/vault/en.json', [
    'deposit.failed.stopped.declined', 'deposit.failed.stopped.too-little-dust',
    'deposit.failed.stopped.not-paid', 'deposit.failed.stopped.network-refused',
  ]],
];

describe('every sentence about how long a deposit holds its vault says as long as the hold lasts', () => {
  for (const [file, keys] of HOLD_SENTENCES) {
    for (const key of keys) {
      // RED WHEN: a sentence names a wait shorter or longer than the hold, or the hold changes and the words do not.
      it(`${key} says ${HOLD_MINUTES} minutes`, () => {
        const text = words(file)[key];
        expect(text, `${key} is in ${file}`).toBeTypeOf('string');
        expect(minutesSaid(text!)).toEqual([HOLD_MINUTES]);
      });
    }
  }
});
