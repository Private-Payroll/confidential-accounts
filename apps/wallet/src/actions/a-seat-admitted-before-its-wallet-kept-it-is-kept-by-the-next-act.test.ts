import { describe, expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import type { ActIntent } from 'midnight-identity/profile/request';
import { signingPublicKeyOf, toHex, wrapKey, type Hex } from '../../../../src/core/crypto.js';
import type { StepContext } from './definition.js';
import { firstReadsAnswered, stepOverItsCall } from './step-views.test-support.js';

/*
 * **A SEAT TAKEN BY ADDRESS AND ADMITTED BEFORE ITS OWN WALLET KEPT IT IS KEPT BY THE NEXT ACT ON THE COMPANY.** The
 * joiner's wallet kept the seat as waiting before it proved it; the service filed its request to be admitted and never
 * gave the answer back (or gave it after the inviter admitted it), so the wallet has no id for it. Once the inviter
 * admitted it, the next act reads the company, finds the wrap of the company's key its seat opens, and keeps the seat
 * under that wrap's id when the roster names that id, active, at the leaf the chain holds. The company's judges are
 * stood in: what they believe of the roster is what each case hands them.
 */

const t = vi.hoisted(() => ({ roster: null as unknown }));
vi.mock('../../../../packages/web-shared/src/company-judges.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/company-judges.js')>()),
  companyJudges: () => ({ companyKeysFor: async () => ({}), openedHere: async () => t.roster })
}));

const { companyReachFor } = await import('./company-reach.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAF = 'aa'.repeat(32);
const WRAPPING = toHex(x25519.utils.randomSecretKey()) as Hex;
const OTHERS = toHex(x25519.utils.randomSecretKey()) as Hex;
/* The seat this wallet's words make for the company: the one it took by address. */
const SIGNING = toHex(seatKeysFor(identity, LABEL, 0).signingSecret) as Hex;
const WAITING = {
  accountId: 'acc_1',
  signingPublicKey: signingPublicKeyOf(SIGNING).toLowerCase(),
  signingSecret: SIGNING,
  wrappingSecret: WRAPPING,
  blinding: '03'.repeat(32),
  scope: '04'.repeat(32),
  seat: 0,
  opening: {
    publicKey: '05'.repeat(32),
    scope: '04'.repeat(32),
    blinding: '03'.repeat(32),
    salt: '06'.repeat(32),
    walletKey: { tag: 'schnorr', value: '07'.repeat(32) }
  },
  joining: {
    invitation: 'inv',
    acceptance: '08'.repeat(32),
    inbox: '09'.repeat(32),
    label: LABEL,
    account: ACCOUNT,
    offer: {},
    confirmed: true as const
  }
};
const wrapTo = (secretKey: Hex, signerId: string) => ({
  signerId,
  ...wrapKey('11'.repeat(32), toHex(x25519.getPublicKey(Buffer.from(secretKey, 'hex'))) as Hex)
});
const SEALED = (wrapped: unknown[]) => ({
  id: 'acc_1',
  companyLabel: LABEL,
  contractAddress: ACCOUNT,
  wrappedKeys: wrapped
});
const why = (key: string) => ({ key });
const activeAt = (id: string, leaf: string, status = 'active') => ({
  id: 'acc_1',
  signers: [
    { id: 'sgn_ada', status: 'active', leafCommitment: 'bb'.repeat(32) },
    { id, status, leafCommitment: leaf }
  ]
});

const world = (
  o: { seats?: string[]; account?: { status: number; body: unknown }; roster?: unknown; waiting?: unknown } = {}
) => {
  const waiting = o.waiting ?? WAITING;
  let keys: any = { accounts: {}, pendingSeats: { [WAITING.signingPublicKey]: waiting } };
  const order: string[] = [];
  const roster = o.roster ?? activeAt('sgn_dee', LEAF);
  const chain = {
    indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
    holders: async () =>
      ({
        seats: o.seats ?? [LEAF, 'bb'.repeat(32)],
        committee: [],
        threshold: 1,
        approvals: 1,
        vaultThresholds: [],
        adoptedVaults: [],
        account: ACCOUNT,
        founding: 'bb'.repeat(32)
      }) as never,
    callState: async () => null
  };
  const builder = {
    ownSeat: async (s: { signingSecret: string }) => (s.signingSecret === SIGNING ? LEAF : 'cc'.repeat(32))
  } as never;
  const answer = o.account ?? { status: 200, body: SEALED([wrapTo(OTHERS, 'sgn_ada'), wrapTo(WRAPPING, 'sgn_dee')]) };
  const ctx = stepOverItsCall({
    intent: { name: 'give-vault-keys', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT } } as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' },
    person: 'dee',
    held: { identity, secret },
    at: { step: 1, steps: 3 },
    signal: new AbortController().signal,
    relay: async () => {},
    call: firstReadsAnswered(async () => answer),
    tell: () => {},
    keyring: {
      open: () => ({ read: () => structuredClone(keys) }),
      keep: async (change: (k: any) => any) => {
        order.push('kept');
        keys = change(structuredClone(keys));
      }
    }
  }) as unknown as StepContext;
  const reached = () => {
    t.roster = roster;
    return companyReachFor(ctx, chain as never, builder, why);
  };
  return { ctx, chain, builder, keysNow: () => keys, order, reached };
};

describe('a seat taken by address and admitted before its own wallet kept it is kept by the next act on the company', () => {
  it("keeps the waiting seat as the company's seat, under the id of the wrap its seat opens, when the roster names it there", async () => {
    const w = world();
    const r = await w.reached();
    /* RED WHEN: the seat stays only in the waiting seats, or is kept under another wrap's id. */
    expect(w.keysNow().accounts['acc_1']).toEqual({
      signerId: 'sgn_dee',
      signingSecret: SIGNING,
      wrappingSecret: WRAPPING,
      blinding: WAITING.blinding,
      scope: WAITING.scope,
      seat: 0,
      opening: WAITING.opening
    });
    expect(r.seat.signerId).toBe('sgn_dee');
    expect(r.leaf).toBe(LEAF);
    /* The waiting seat stays as it was: a seat held is never dropped. */
    expect(w.keysNow().pendingSeats).toEqual({ [WAITING.signingPublicKey]: WAITING });
    /* RED WHEN: a seat the person confirmed and the chain seats is used without its company pinned to the confirmed account. */
    expect(w.keysNow().pins?.[LABEL]).toMatchObject({ account: ACCOUNT, from: 'invited' });
    expect(w.order).toEqual(['kept', 'kept']);
  });

  it('never pins a waiting seat the person did not confirm, or one confirmed for another account, and refuses the reach', async () => {
    const { confirmed: _no, ...unconfirmed } = WAITING.joining;
    for (const waiting of [
      { ...WAITING, joining: unconfirmed },
      { ...WAITING, joining: { ...WAITING.joining, account: 'c1'.repeat(32) } }
    ]) {
      const w = world({ waiting });
      /* RED WHEN: a waiting seat is pinned, or reached, though the person never confirmed this company's fingerprint for it. */
      await expect(w.reached()).rejects.toMatchObject({ words: { key: 'no-pin' } });
      expect([w.order, w.keysNow().accounts, w.keysNow().pins]).toEqual([[], {}, undefined]);
    }
  });

  it('RED WHEN: a waiting seat is kept that the roster does not name active at the leaf the chain holds, or the chain does not hold, or the service will not show', async () => {
    const cases = [
      world({ roster: activeAt('sgn_dee', 'dd'.repeat(32)) }),
      world({ roster: activeAt('sgn_dee', LEAF, 'leaver') }),
      world({ roster: activeAt('sgn_bo', LEAF) }),
      world({ account: { status: 403, body: { error: 'not a member' } } }),
      world({ account: { status: 200, body: SEALED([wrapTo(OTHERS, 'sgn_dee')]) } })
    ];
    for (const w of cases) {
      await expect(w.reached()).rejects.toMatchObject({ words: { key: 'no-seat' } });
      /* The company is pinned once the chain seats the confirmed seat's leaf; the seat itself is not kept. */
      expect(w.keysNow().accounts).toEqual({});
    }
    /* A waiting seat whose leaf the chain does not hold pins nothing. */
    const unseated = world({ seats: ['bb'.repeat(32)] });
    await expect(unseated.reached()).rejects.toMatchObject({ words: { key: 'no-pin' } });
    expect([unseated.order, unseated.keysNow().pins]).toEqual([[], undefined]);
  });
});
