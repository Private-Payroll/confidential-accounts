import { describe, expect, it } from 'vitest';
import { WalletClosed, type WalletRefusal } from 'vaults-web-shared/wallet-sign-in.js';
import * as keyring from 'vaults-web-shared/keyring.js';
import { ReadRanOutOfTime } from 'vaults-web-shared/read-bound.js';
import { ACT_REFUSAL, refusalOf } from './refusals.js';

/*
 * WHAT A WALLET'S REFUSAL BECOMES ON A SCREEN: each way a wallet can end an
 * ask is told by its own kind, so each is said truly.
 */
const closed = (refusal: WalletRefusal, message = 'x') => new WalletClosed(refusal, message);

describe('a company not finished', () => {
  /* RED WHEN: a person is told they cannot create a company because another is not finished: the refusal, its class or its code is still there. */
  it('is never a reason to refuse: there is no kind, code or words for it', () => {
    expect(keyring).not.toHaveProperty('ACompanyIsBeingCreated');
    expect(Object.values(ACT_REFUSAL)).not.toContain('company-kept');
    expect(refusalOf(new Error('a company you started is not finished yet'))).toBe(ACT_REFUSAL.didNotFinish);
  });
});

describe('a wallet that did not answer, ran out, or could not read', () => {
  /* RED WHEN: an ask that ran out while the wallet was open is told as one that had expired before it arrived, or the other way round. */
  it('tells an ask that ran out while open apart from one that expired on arrival', () => {
    expect(refusalOf(closed({ of: 'expired', while: 'open' }))).toBe(ACT_REFUSAL.ranOut);
    expect(refusalOf(closed({ of: 'expired' }))).toBe(ACT_REFUSAL.expired);
  });

  /* RED WHEN: a wallet that opened and never answered is told "it did not finish", with no word that nothing was signed or sent. */
  it('tells a wallet that never answered as silent', () => {
    expect(refusalOf(closed({ of: 'silent' }))).toBe(ACT_REFUSAL.silent);
  });

  /* RED WHEN: a person who stopped waiting for their wallet is told "it did not finish", as though something had failed. */
  it('tells a person who stopped waiting as that', () => {
    expect(refusalOf(closed({ of: 'gave-up' }))).toBe(ACT_REFUSAL.gaveUp);
  });

  /* RED WHEN: a wallet that would not take the request is told as one that did not finish. */
  it('tells a request the wallet would not take as that', () => {
    expect(refusalOf(closed({ of: 'unreadable' }))).toBe(ACT_REFUSAL.unreadable);
  });

  /* RED WHEN: a payment the wallet could not make is told as one that did not finish, or two reasons share one kind. */
  it('tells each reason a payment failed by its own kind', () => {
    const kinds = (['chain-unreadable', 'not-enough', 'not-as-approved', 'did-not-finish'] as const)
      .map((why) => refusalOf(closed({ of: 'failed', why })));
    expect(new Set(kinds).size).toBe(4);
    expect(kinds).not.toContain(ACT_REFUSAL.didNotFinish);
  });
});

describe('a read that ran out of time', () => {
  /* RED WHEN: a read that did not answer within twenty seconds is told as an unfinished action, or as a service that could not be reached. */
  it('is told by its own kind, apart from an action that did not finish', () => {
    expect(refusalOf(new ReadRanOutOfTime('The service'))).toBe(ACT_REFUSAL.readRanOut);
  });
});
