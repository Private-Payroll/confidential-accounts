import { identityFromWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import type { WrappingKeypair } from './crypto.js';
import { payslipKeypairFrom } from './payslip-key-derive.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from './wallet-unlock.js';

/**
 * **THE WALLET'S HALF OF THE PAYSLIP KEY.** `docs/NEXT.md` PI2b §2.
 *
 * The derivation itself — what it expands, what it deliberately does not, and
 * why any thirty-two bytes are a usable x25519 secret — lives in
 * `payslip-key-derive.ts` and is re-exported here unchanged. **It was split out
 * rather than copied**, because this file imports the wallet's root barrel and
 * the payroll page cannot: `C149`, and that file's header has the measurement.
 */
export { payslipKeypairFrom } from './payslip-key-derive.js';

/**
 * **THE SAME KEY, FROM THE WORDS A WALLET IS REBUILT FROM.**
 *
 * This is what a second device does: twenty-four words in, the company's own
 * address, and out comes the keypair that opens payslips issued before that
 * device existed. **It walks the wallet's real code** — `identityFromWords`,
 * `parseAsk` and `unlockKeyFor` all ship from `midnight-identity` — rather than
 * describing what the wallet would have done, for the reason
 * `wallet-unlock.test.ts` depends on the package: if the two sides ever
 * disagreed about a byte, this is what would notice.
 *
 * `atOrigin` GATES AND DOES NOT DERIVE. The wallet refuses an origin it cannot
 * make sense of, and derives from the company alone (`unlock.ts:293-313`) — so
 * every usable origin yields the same key here, which is the property the whole
 * design rests on and is pinned by a test rather than left as a reading.
 */
export function payslipKeypairForWallet(
  words: readonly string[] | string, company: string, atOrigin: string,
): WrappingKeypair {
  const ask = parseAsk(
    unlockAsk({
      name: 'Confidential Accounts',
      rdns: 'social.lemonade.confidential-accounts',
      purpose: UNLOCK_PURPOSE,
      /*
       * A NONCE AND A CLOCK ARE THE CONVERSATION'S, NEVER THE KEY'S. Both are
       * checked by the parser and neither reaches `unlockKeyFor`, which is what
       * makes this recomputable at all: a key that moved with the clock could
       * not open yesterday's payslip.
       */
      nonce: 'derivation-has-no-conversation',
      expiresAt: 0 + UNLOCK_WINDOW_MS,
      company,
    }),
    atOrigin,
    0,
  );
  if (ask.kind !== 'unlock') throw new Error(`built a ${ask.kind}, not an unlock`);
  return payslipKeypairFrom(unlockKeyFor(identityFromWords(words), ask));
}
