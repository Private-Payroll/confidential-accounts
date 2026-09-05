import { describe, it, expect } from 'vitest';
import {
  principal, admitFactor, removeFactor, canAct, canAdmit, securityRung, mayHoldMoney,
  payableAddress, startingRules, admitRuleFor, type Factor,
} from './principal.js';
import { newSigningKeypair, newWrappingKeypair } from './crypto.js';
import { payeeFor } from '../testing/payees.js';

const factor = (id: string, kind: Factor['kind'] = 'device'): Factor => ({
  id, kind, label: id, enrolledAt: '2026-08-17T00:00:00.000Z',
  signingPublicKey: newSigningKeypair().publicKey,
  wrappingPublicKey: newWrappingKeypair().publicKey,
});

const one = () => principal({ id: 'p1', factors: [factor('laptop')], rules: startingRules() });

describe('a principal is a set of factors and two rules', () => {
  it('starts as one device that may admit a second', () => {
    const p = one();
    expect(p.rules).toEqual({ toAct: 1, toAdmit: 1 });
    expect(securityRung(p)).toBe(1);
  });

  it('tightens when the second factor arrives, and never loosens after', () => {
    const p = admitFactor(one(), factor('phone'));
    expect(p.rules.toAdmit).toBe(2);
    const three = admitFactor(p, factor('passkey', 'passkey'));
    expect(three.rules.toAdmit).toBe(2);
    expect(three.rules.toAct).toBe(1);
  });

  it('is frozen, factors and rules included', () => {
    const p = one();
    expect(Object.isFrozen(p)).toBe(true);
    expect(() => (p.factors as Factor[]).push(factor('sneak'))).toThrow();
    expect(() => { (p.rules as { toAdmit: number }).toAdmit = 1; }).toThrow();
  });
});

describe('what it refuses, and why each one is a way in or a way out', () => {
  it('no factors at all — nobody could ever get in, including us', () => {
    expect(() => principal({ id: 'p', factors: [], rules: startingRules() }))
      .toThrow(/no way in/);
  });

  /*
   * THE ONE THAT IS NOT OBVIOUS. Two factors with the same signing key make a
   * "two of three" that one device satisfies twice: the count says three, the
   * safety is one lower, and nothing about the record looks wrong. A guard that
   * looks like protection and is not is worse than an honest absence of one.
   */
  it('two factors sharing a signing key, which counts twice and protects once', () => {
    const a = factor('laptop');
    const clone = { ...factor('phone'), signingPublicKey: a.signingPublicKey };
    expect(() => principal({
      id: 'p', factors: [a, clone], rules: { toAct: 1, toAdmit: 2 },
    })).toThrow(/counts twice and protects once/);
  });

  it('two factors sharing an id, so one of them is invisible', () => {
    expect(() => principal({
      id: 'p', factors: [factor('same'), factor('same')], rules: { toAct: 1, toAdmit: 2 },
    })).toThrow(/share an id/);
  });

  it('a rule nothing could ever meet — the frozen-out account', () => {
    expect(() => principal({
      id: 'p', factors: [factor('a'), factor('b')], rules: { toAct: 3, toAdmit: 3 },
    })).toThrow(/nothing could ever be approved/);
    expect(() => principal({
      id: 'p', factors: [factor('a'), factor('b')], rules: { toAct: 1, toAdmit: 5 },
    })).toThrow(/no new factor could ever be added/);
  });

  /*
   * If admitting is easier than acting, one stolen factor enrols the thief's
   * own device and the account is theirs — while the owner still holds
   * everything they had, so nothing looks wrong until it is far too late.
   */
  it('admitting being easier than acting', () => {
    expect(() => principal({
      id: 'p', factors: [factor('a'), factor('b'), factor('c')],
      rules: { toAct: 3, toAdmit: 2 },
    })).toThrow(/never be easier than acting/);
  });

  it('two factors with a rule of one to admit — one stolen phone is the account', () => {
    expect(() => principal({
      id: 'p', factors: [factor('a'), factor('b')], rules: { toAct: 1, toAdmit: 1 },
    })).toThrow(/from two onwards/);
  });
});

describe('removing a factor never strands the principal', () => {
  it('refuses to remove the last one', () => {
    expect(() => removeFactor(one(), 'laptop')).toThrow(/lock this account for good/);
  });

  it('refuses when what is left could not admit a replacement', () => {
    const p = admitFactor(one(), factor('phone'));   // two factors, toAdmit 2
    expect(() => removeFactor(p, 'phone')).toThrow(/no replacement could ever be added/);
  });

  it('allows it when a quorum survives', () => {
    const p = admitFactor(admitFactor(one(), factor('phone')), factor('passkey', 'passkey'));
    const after = removeFactor(p, 'passkey');
    expect(after.factors.map(f => f.id)).toEqual(['laptop', 'phone']);
  });

  it('says so when there is nothing by that name', () => {
    expect(() => removeFactor(one(), 'nope')).toThrow(/no factor "nope"/);
  });
});

describe('meeting the rules', () => {
  const p = admitFactor(admitFactor(one(), factor('phone')), factor('code', 'recovery-code'));

  it('counts distinct factors, so one presented twice is one', () => {
    expect(canAct(p, ['laptop', 'laptop'])).toBe(true);        // toAct is 1
    expect(canAdmit(p, ['laptop', 'laptop'])).toBe(false);     // toAdmit is 2
    expect(canAdmit(p, ['laptop', 'phone'])).toBe(true);
  });

  it('ignores ids that are not factors of this principal', () => {
    expect(canAdmit(p, ['laptop', 'somebody-elses-phone'])).toBe(false);
  });
});

describe('the ladder, and the gate on money', () => {
  it('one device is rung 1, and rung 1 may not hold money — C11', () => {
    const p = one();
    expect(securityRung(p)).toBe(1);
    expect(mayHoldMoney(p)).toBe(false);
  });

  it('a device plus a recovery code is rung 2', () => {
    const p = admitFactor(one(), factor('code', 'recovery-code'));
    expect(securityRung(p)).toBe(2);
    expect(mayHoldMoney(p)).toBe(true);
  });

  it('two real factors is rung 3', () => {
    const p = admitFactor(one(), factor('phone'));
    expect(securityRung(p)).toBe(3);
    expect(mayHoldMoney(p)).toBe(true);
  });

  /*
   * A recovery code on its own is not a rung. It is the thing you use when
   * everything else is gone; if it is the only factor, there is nothing else.
   */
  it('a recovery code alone is still rung 1', () => {
    const p = principal({
      id: 'p', factors: [factor('code', 'recovery-code')], rules: startingRules(),
    });
    expect(securityRung(p)).toBe(1);
    expect(mayHoldMoney(p)).toBe(false);
  });

  it('admitRuleFor is the rule stated once', () => {
    expect([0, 1, 2, 3, 9].map(admitRuleFor)).toEqual([1, 1, 2, 2, 2]);
  });
});

describe('a factor that cannot act does not count as one', () => {
  /*
   * A wallet supplies an ADDRESS and no authority — a wallet address that
   * submits is public and would rebuild the membership graph the blinded tree
   * exists to destroy. So it must not raise a count that decides whether
   * anything can be approved.
   *
   * Counted, `[laptop, wallet]` would read as two factors: the rule to admit
   * tightens to two, the ladder reports the top rung, the money gate opens —
   * and the real quorum is one, so no replacement could ever be enrolled. The
   * count says two and the safety is one, which is the same defect this file
   * refuses for two factors sharing a signing key.
   */
  const withWallet = () => admitFactor(one(), factor('ledger-nano', 'wallet'));

  it('does not tighten the rule to admit', () => {
    expect(withWallet().rules.toAdmit).toBe(1);
  });

  it('does not lift the rung, and does not open the money gate', () => {
    expect(securityRung(withWallet())).toBe(1);
    expect(mayHoldMoney(withWallet())).toBe(false);
  });

  it('cannot satisfy a rule by being presented', () => {
    const p = withWallet();
    expect(canAct(p, ['ledger-nano'])).toBe(false);
    expect(canAct(p, ['laptop'])).toBe(true);
  });

  it('a principal made only of wallets is refused outright', () => {
    expect(() => principal({
      id: 'p', factors: [factor('nano', 'wallet')], rules: startingRules(),
    })).toThrow(/no way to act at all/);
  });

  it('and removing the real factor beside it is refused', () => {
    expect(() => removeFactor(withWallet(), 'laptop')).toThrow(/lock this account for good/);
  });
});

describe('payable means more than having an address — C9', () => {
  const addr = payeeFor(new Uint8Array(32).fill(0x21), 'undeployed');

  it('hands over the address when there is one and a way in', () => {
    const p = principal({ id: 'p', factors: [factor('laptop')], rules: startingRules(), address: addr });
    expect(payableAddress(p).bech32).toBe(addr.bech32);
  });

  it('refuses when there is no address, and says where one must come from', () => {
    expect(() => payableAddress(one())).toThrow(/their own device or wallet/);
  });

  it('defaults the address to null rather than leaving it undefined', () => {
    expect(one().address).toBeNull();
  });
});
