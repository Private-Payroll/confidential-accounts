import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  COMMITTEE_CHANGE_REFUSAL, NothingToSign, committeeChangeRefusal, contractsForMe, signCommitteeChangeOnDevice, whyNotSignCommitteeChange,
  type CommitteeChangeDoors, type CommitteeChangeView, type CommitteeTarget,
} from './committee-change-on-device.js';

/*
 * A super admin's own device, asked to sign the change that brings the
 * company's contracts to its committee: what it checks against the committee
 * holding the account on the chain, or the super admins' change in progress,
 * before its wallet is asked, and which contracts it asks the wallet about: a
 * key signs a contract's change where it holds a place on that contract's
 * committee, and nowhere else. No seat, roster or signer is read.
 */
/** Wallet key `n`: the x-only public key of a secret made of one repeated byte, a key the chain builds a committee with. */
const k = (n: number) => ({ tag: 'schnorr', value: Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex') });
/* The account is held on the chain by keys 1 and 2 at two: the super admins. */
const TARGET: CommitteeTarget = { account: { committee: [k(1), k(2)], threshold: 2 }, inProgress: null };
const VAULT = 'ab'.repeat(32);
/* The company's account, and the label it carries. */
const COMPANY = 'c0'.repeat(32);
const LABEL = `co_${'c1'.repeat(32)}`;

const view = (over: Partial<CommitteeChangeView> = {}): CommitteeChangeView => ({
  company: COMPANY,
  label: LABEL,
  to: { committee: [k(1), k(2)], threshold: 2 },
  why: null,
  contracts: [
    { contract: 'account', address: COMPANY, counter: '1', now: { committee: [k(1)], threshold: 1 }, signedIndexes: [], required: 1 },
    { contract: 'vault', address: VAULT, counter: '3', now: { committee: [k(1), k(3)], threshold: 2 }, signedIndexes: [0], required: 2 },
    { contract: 'vault', address: 'dd'.repeat(32), counter: '2', now: { committee: [k(3), k(4)], threshold: 1 }, signedIndexes: [], required: 1 },
  ],
  notChangeable: [],
  ...over,
});

describe('WHAT A SIGNER\'S DEVICE CHECKS BEFORE ITS WALLET IS ASKED TO SIGN A COMMITTEE CHANGE', () => {
  it('asks only about contracts this person holds a seat on and has not signed yet', () => {
    /* RED WHEN: a contract already signed at this seat, or one this person holds no seat on, is sent to the wallet. */
    expect(contractsForMe(view(), k(1)).map((c) => c.address)).toEqual([COMPANY]);
    expect(contractsForMe(view(), k(3)).map((c) => c.address)).toEqual([VAULT, 'dd'.repeat(32)]);
  });

  it('REFUSES A COMMITTEE OTHER THAN THE ONE HOLDING THE ACCOUNT, A WALLET KEY ON NO CONTRACT BEHIND, AND NOTHING LEFT TO SIGN', () => {
    expect(whyNotSignCommitteeChange(view(), k(1), TARGET)).toBeNull();
    /* RED WHEN: the device takes the service's word for the committee to install. */
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1), k(5)], threshold: 2 } }), k(1), TARGET))
      .toMatch(/other than the one holding the company's account on the chain.*No change is signed from here/);
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1), k(2)], threshold: 1 } }), k(1), TARGET))
      .toMatch(/other than the one holding the company's account on the chain/);
    /* RED WHEN: a wallet key that holds no place on any contract behind is asked to sign. */
    expect(whyNotSignCommitteeChange(view(), k(7), TARGET)).toMatch(/you do not hold a seat on any contract that needs this change/);
    expect(whyNotSignCommitteeChange(view({ contracts: [] }), k(1), TARGET)).toMatch(/already held by its committee/);
    expect(whyNotSignCommitteeChange(view({ contracts: [view().contracts[1]!] }), k(1), TARGET))
      .toMatch(/you have signed the change on every contract you hold a seat on/);
    /* RED WHEN: a person who holds no seat on anything behind is told they have signed. */
    expect(whyNotSignCommitteeChange(view({ contracts: [view().contracts[2]!] }), k(1), TARGET))
      .toMatch(/you do not hold a seat on any contract that needs this change/);
    expect(whyNotSignCommitteeChange(view({ to: null, why: 'no committee yet' }), k(1), TARGET)).toBe('no committee yet');
  });

  it('A SIGNER JOINING OR LEAVING NEVER MOVES THE COMMITTEE A CHANGE IS JUDGED AGAINST', () => {
    /* A third signer is seated; a committee made from the signers would now be three keys. */
    const theSignersCommittee = { committee: [k(1), k(2), k(5)], threshold: 2 };
    /* RED WHEN: a committee built from the signers or the roster is the target: the change to it is signed. */
    expect(whyNotSignCommitteeChange(view({ to: theSignersCommittee }), k(1), TARGET))
      .toMatch(/never because a signer joined or left/);
    expect(whyNotSignCommitteeChange(view(), k(1), TARGET)).toBeNull();
  });

  it('WHILE THE SUPER ADMINS CHANGE, THE CHANGE IN PROGRESS IS THE ONLY TARGET', () => {
    const inProgress: CommitteeTarget = {
      account: { committee: [k(1)], threshold: 1 },
      inProgress: { committee: [k(1), k(2)], threshold: 2, contracts: [{ address: COMPANY, counter: 1n }] },
    };
    /* RED WHEN: the super admins' own change in progress is not a committee a change may install. */
    expect(whyNotSignCommitteeChange(view(), k(1), inProgress)).toBeNull();
    /* RED WHEN: a change back to the account's committee is signed while the super admins' change is in progress. */
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1)], threshold: 1 } }), k(1), inProgress))
      .toMatch(/other than the one the super admins' change in progress installs/);
  });

  it('SEVERAL SUPER ADMINS AT A THRESHOLD OF ONE ARE SIGNED FOR; A KEY TWICE OR A THRESHOLD OUTSIDE THE KEYS IS NOT', () => {
    const severalAtOne: CommitteeTarget = { account: { committee: [k(1), k(2)], threshold: 1 }, inProgress: null };
    /* RED WHEN: the company's choice of several super admins at one is refused on this device. */
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1), k(2)], threshold: 1 } }), k(1), severalAtOne)).toBeNull();
    for (const to of [{ committee: [k(1), k(1)], threshold: 2 }, { committee: [k(1), k(2)], threshold: 0 }, { committee: [k(1), k(2)], threshold: 3 }]) {
      const target: CommitteeTarget = { account: to, inProgress: null };
      /* RED WHEN: the one install rule is not asked before the wallet is. */
      expect(whyNotSignCommitteeChange(view({ to }), k(1), target)).toMatch(/^no change is signed from here: /);
    }
  });
});

describe('WHICH KIND OF REFUSAL IT IS, AS A CODE', () => {
  /*
   * RED WHEN: a screen can tell "nothing to sign" from a refusal only by its
   * sentence: either kind of nothing to sign is given another code, a refusal
   * is given the nothing-to-sign code, the sentence differs from the one the
   * check gives, or the flow's error stops carrying the code.
   */
  it('gives "nothing to sign" its own code, for both reasons there is nothing, and every other refusal the other', async () => {
    const cases: [CommitteeChangeView, { tag: string; value: string }, string | null][] = [
      [view({ contracts: [view().contracts[1]!] }), k(1), COMMITTEE_CHANGE_REFUSAL.nothingToSign],
      [view({ contracts: [view().contracts[2]!] }), k(1), COMMITTEE_CHANGE_REFUSAL.nothingToSign],
      [view({ to: { committee: [k(1), k(5)], threshold: 2 } }), k(1), COMMITTEE_CHANGE_REFUSAL.refused],
      [view(), k(7), COMMITTEE_CHANGE_REFUSAL.nothingToSign],
      [view({ contracts: [] }), k(1), COMMITTEE_CHANGE_REFUSAL.refused],
      [view({ to: { committee: [k(1), k(2)], threshold: 1 } }), k(1), COMMITTEE_CHANGE_REFUSAL.refused],
      [view({ to: null, why: 'no committee yet' }), k(1), COMMITTEE_CHANGE_REFUSAL.refused],
      [view(), k(1), null],
    ];
    for (const [v, mine, code] of cases) {
      const got = committeeChangeRefusal(v, mine, TARGET);
      expect(got?.code ?? null).toBe(code);
      expect(got?.why ?? null).toBe(whyNotSignCommitteeChange(v, mine, TARGET));
    }
    const thrown = await signCommitteeChangeOnDevice({
      view: async () => view({ contracts: [view().contracts[1]!] }), walletKey: async () => k(1), target: async () => TARGET,
      askWallet: async () => { throw new Error('the wallet was asked'); }, send: async () => ({ results: [] }), sendNow: async () => ({}),
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NothingToSign);
    expect((thrown as NothingToSign).code).toBe(COMMITTEE_CHANGE_REFUSAL.nothingToSign);
  });
});

describe('THE FLOW', () => {
  const doors = (over: Partial<CommitteeChangeDoors> = {}, log: unknown[] = []): CommitteeChangeDoors => ({
    view: async () => view(),
    walletKey: async () => k(1),
    target: async () => TARGET,
    askWallet: async (ask) => {
      log.push(ask);
      return { signer: k(1), signatures: ask.contracts.map((c) => ({ address: c.address, counter: c.counter, seat: 0, signature: k(0xee) })) };
    },
    send: async (body) => { log.push(body); return { results: [{ address: COMPANY, state: 'kept', have: 1, required: 1 }] }; },
    sendNow: async (update) => { log.push({ sendNow: update }); return {}; },
    ...over,
  });

  it('asks the wallet for the change to the account\'s committee on this person\'s contracts, and hands on only what it signed', async () => {
    const log: unknown[] = [];
    await signCommitteeChangeOnDevice(doors({}, log));
    expect(log[0]).toEqual({
      company: LABEL, account: COMPANY, to: { committee: [k(1), k(2)], threshold: 2 },
      contracts: [{ contract: 'account', address: COMPANY, counter: '1', now: { committee: [k(1)], threshold: 1 } }],
    });
    /* RED WHEN: a signature is handed on by anything but its place on the committee. */
    expect(log[1]).toEqual({
      to: { committee: [k(1), k(2)], threshold: 2 },
      signatures: [{ address: COMPANY, counter: '1', index: 0, signature: k(0xee) }],
    });
    /* RED WHEN: the device stops asking for the send once the signatures kept reach the threshold - the service sends
     * nothing on its own. */
    expect(log[2]).toEqual({ sendNow: { address: COMPANY, counter: '1', to: { committee: [k(1), k(2)], threshold: 2 } } });
    expect(log).toHaveLength(3);
  });

  it('asks for no send while the signatures kept are short of the threshold', async () => {
    const log: unknown[] = [];
    /* RED WHEN: a send is asked for a contract still short of signatures - the service would refuse it, or pay for nothing. */
    await signCommitteeChangeOnDevice(doors({ send: async (body) => { log.push(body); return { results: [{ address: COMPANY, state: 'kept', have: 0, required: 1 }] }; } }, log));
    expect(log).toHaveLength(2);
  });

  it('NOTHING TO SIGN IS SAID AS THAT, NOT AS A FAILURE, AND THE WALLET IS NOT ASKED', async () => {
    const log: unknown[] = [];
    const e = await signCommitteeChangeOnDevice(doors({ view: async () => view({ contracts: [view().contracts[2]!] }) }, log))
      .catch((x) => x);
    expect(e).toBeInstanceOf(NothingToSign);
    expect(log).toEqual([]);
  });

  it('ASKS NOTHING OF THE WALLET WHEN THE CHECK REFUSES, AND HANDS ON NOTHING SIGNED BY ANOTHER KEY', async () => {
    const log: unknown[] = [];
    await expect(signCommitteeChangeOnDevice(doors({ view: async () => view({ to: { committee: [k(1), k(5)], threshold: 2 } }) }, log)))
      .rejects.toThrow(/other than the one holding the company's account on the chain/);
    expect(log).toEqual([]);
    /* RED WHEN: signatures from a key other than the one this wallet gives for the company are passed on. */
    await expect(signCommitteeChangeOnDevice(doors({
      askWallet: async () => ({ signer: k(2), signatures: [{ address: COMPANY, counter: '1', seat: 0, signature: k(0xee) }] }),
    }, log))).rejects.toThrow(/signed with a key other than/);
    expect(log).toEqual([]);
  });

});

describe('A SUPER ADMIN IS A KEY ON THE ACCOUNT\'S COMMITTEE, AND NOTHING OF THE SIGNERS IS READ', () => {
  const flow = (over: Partial<CommitteeChangeDoors>, log: unknown[], read: string[]): CommitteeChangeDoors => ({
    view: async () => { read.push('view'); return view(); },
    walletKey: async () => { read.push('wallet key'); return k(2); },
    target: async () => { read.push('the chain'); return TARGET; },
    askWallet: async (ask) => {
      log.push(ask);
      return { signer: k(2), signatures: ask.contracts.map((c) => ({ address: c.address, counter: c.counter, seat: 1, signature: k(0xee) })) };
    },
    send: async (body) => { log.push(body); return { results: [] }; },
    sendNow: async () => ({}),
    ...over,
  });

  it('a super admin with no seat and no roster entry signs the change on their own device', async () => {
    /* Key 2 is on the account's committee and holds the account behind; nobody seated it and no roster names it. */
    const behind = view({ contracts: [{ ...view().contracts[0]!, now: { committee: [k(1), k(2)], threshold: 2 } }] });
    const log: unknown[] = [];
    const read: string[] = [];
    /* RED WHEN: the roster is read on the way to the wallet, or a roster entry carrying the wallet key is required. */
    await signCommitteeChangeOnDevice(flow({ view: async () => { read.push('view'); return behind; } }, log, read));
    expect(read).toEqual(['view', 'wallet key', 'the chain']);
    expect(log[0]).toEqual({ company: LABEL, account: COMPANY, to: { committee: [k(1), k(2)], threshold: 2 }, contracts: [
      { contract: 'account', address: COMPANY, counter: '1', now: { committee: [k(1), k(2)], threshold: 2 } },
    ] });
    expect(log).toHaveLength(2);
  });

  it('a key the account no longer lists still signs forward the vaults it holds, and only those', async () => {
    /* Key 3 still holds two vaults, and the chain says the super admins are keys 1 and 2. */
    expect(contractsForMe(view(), k(3))).toHaveLength(2);
    /* RED WHEN: standing to sign a vault's change is read from the account's committee rather than the vault's own. */
    expect(whyNotSignCommitteeChange(view(), k(3), TARGET)).toBeNull();
    const log: unknown[] = [];
    await signCommitteeChangeOnDevice(flow({
      walletKey: async () => k(3),
      askWallet: async (ask) => {
        log.push(ask);
        return { signer: k(3), signatures: ask.contracts.map((c) => ({ address: c.address, counter: c.counter, seat: 0, signature: k(0xee) })) };
      },
    }, log, []));
    expect((log[0] as { contracts: Array<{ address: string }> }).contracts.map((c) => c.address)).toEqual([VAULT, 'dd'.repeat(32)]);
  });
});
