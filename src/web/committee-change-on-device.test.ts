import { describe, it, expect } from 'vitest';
import type { Account } from '../core/types.js';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { signVaultKeys } from '../core/vault-keys.js';
import {
  NothingToSign, contractsForMe, signCommitteeChangeOnDevice, whyNotSignCommitteeChange,
  type CommitteeChangeDoors, type CommitteeChangeView,
} from './committee-change-on-device.js';

/*
 * A signer's own device, asked to sign the change that brings the company's
 * contracts to its committee: what it checks against the roster it opened
 * before its wallet is asked, and which contracts it asks the wallet about.
 */
const k = (n: number) => ({ tag: 'schnorr', value: n.toString(16).padStart(2, '0').repeat(32) });
const ADA = newSigningKeypair();
const BO = newSigningKeypair();
const entry = (id: string, pair: { publicKey: Hex; secret: Hex }, key: number, signedBy = pair) => ({
  id, userId: id, name: id, status: 'active', signingPublicKey: pair.publicKey,
  vaultKeys: signVaultKeys('acc_1', id, { committeeKey: k(key), recordsKey: k(key + 0x10).value as Hex }, signedBy.secret),
});
const roster = { id: 'acc_1', signers: [entry('ada', ADA, 1), entry('bo', BO, 2)] } as unknown as Account;
const ME = { signerId: 'ada' };
const VAULT = 'ab'.repeat(32);
const COMPANY = 'c0'.repeat(32);

const view = (over: Partial<CommitteeChangeView> = {}): CommitteeChangeView => ({
  company: COMPANY,
  to: { committee: [k(1), k(2)], threshold: 2 },
  why: null,
  contracts: [
    { contract: 'account', address: COMPANY, counter: '1', now: { committee: [k(1)], threshold: 1 }, signedSeats: [], required: 1 },
    { contract: 'vault', address: VAULT, counter: '3', now: { committee: [k(1), k(3)], threshold: 2 }, signedSeats: [0], required: 2 },
    { contract: 'vault', address: 'dd'.repeat(32), counter: '2', now: { committee: [k(3), k(4)], threshold: 1 }, signedSeats: [], required: 1 },
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

  it('REFUSES A COMMITTEE THE ROSTER DOES NOT NAME, ONE MISSING A SEATED SIGNER, A WALLET KEY THE ROSTER DOES NOT GIVE THIS PERSON, AND NOTHING LEFT TO SIGN', () => {
    expect(whyNotSignCommitteeChange(view(), k(1), roster, ME)).toBeNull();
    /* RED WHEN: the device takes the service's word for the committee to install. */
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1), k(5)], threshold: 2 } }), k(1), roster, ME))
      .toMatch(/roster does not name.*No change is signed from here/);
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1)], threshold: 1 } }), k(1), roster, ME))
      .toMatch(/has 1 key\(s\) and the company's own roster names 2/);
    expect(whyNotSignCommitteeChange(view(), k(7), roster, ME)).toMatch(/does not carry the key your wallet gives/);
    expect(whyNotSignCommitteeChange(view({ contracts: [] }), k(1), roster, ME)).toMatch(/already held by its committee/);
    expect(whyNotSignCommitteeChange(view({ contracts: [view().contracts[1]!] }), k(1), roster, ME))
      .toMatch(/you have signed the change on every contract you hold a seat on/);
    /* RED WHEN: a person who holds no seat on anything behind is told they have signed. */
    expect(whyNotSignCommitteeChange(view({ contracts: [view().contracts[2]!] }), k(1), roster, ME))
      .toMatch(/you do not hold a seat on any contract that needs this change/);
    /* RED WHEN: the threshold the service reports is taken over the one the company's own record holds. */
    const withPolicy = { ...roster, policy: { threshold: 2 } } as unknown as Account;
    expect(whyNotSignCommitteeChange(view(), k(1), withPolicy, ME)).toBeNull();
    expect(whyNotSignCommitteeChange(view({ to: { committee: [k(1), k(2)], threshold: 1 } }), k(1), withPolicy, ME))
      .toMatch(/the service says 1 of the company's signers must sign a change after this one, and the company's own record says 2/);
    expect(whyNotSignCommitteeChange(view({ to: null, why: 'no committee yet' }), k(1), roster, ME)).toBe('no committee yet');
  });
});

describe('THE FLOW', () => {
  const doors = (over: Partial<CommitteeChangeDoors> = {}, log: unknown[] = []): CommitteeChangeDoors => ({
    view: async () => view(),
    walletKey: async () => k(1),
    roster: async () => roster,
    askWallet: async (ask) => {
      log.push(ask);
      return { signer: k(1), signatures: ask.contracts.map((c) => ({ address: c.address, counter: c.counter, seat: 0, signature: k(0xee) })) };
    },
    send: async (body) => { log.push(body); return { results: [{ state: 'sent' }] }; },
    ...over,
  });

  it('asks the wallet for the change to the roster\'s committee on this person\'s contracts, and hands on only what it signed', async () => {
    const log: unknown[] = [];
    await signCommitteeChangeOnDevice(doors({}, log), ME);
    expect(log[0]).toEqual({
      company: COMPANY, to: { committee: [k(1), k(2)], threshold: 2 },
      contracts: [{ contract: 'account', address: COMPANY, counter: '1', now: { committee: [k(1)], threshold: 1 } }],
    });
    expect(log[1]).toEqual({
      to: { committee: [k(1), k(2)], threshold: 2 },
      signatures: [{ address: COMPANY, counter: '1', seat: 0, signature: k(0xee) }],
    });
  });

  it('NOTHING TO SIGN IS SAID AS THAT, NOT AS A FAILURE, AND THE WALLET IS NOT ASKED', async () => {
    const log: unknown[] = [];
    const e = await signCommitteeChangeOnDevice(doors({ view: async () => view({ contracts: [view().contracts[2]!] }) }, log), ME)
      .catch((x) => x);
    expect(e).toBeInstanceOf(NothingToSign);
    expect(log).toEqual([]);
  });

  it('ASKS NOTHING OF THE WALLET WHEN THE CHECK REFUSES, AND HANDS ON NOTHING SIGNED BY ANOTHER KEY', async () => {
    const log: unknown[] = [];
    await expect(signCommitteeChangeOnDevice(doors({ view: async () => view({ to: { committee: [k(1), k(5)], threshold: 2 } }) }, log), ME))
      .rejects.toThrow(/roster does not name/);
    expect(log).toEqual([]);
    /* RED WHEN: signatures from a key other than the one this wallet gives for the company are passed on. */
    await expect(signCommitteeChangeOnDevice(doors({
      askWallet: async () => ({ signer: k(2), signatures: [{ address: COMPANY, counter: '1', seat: 0, signature: k(0xee) }] }),
    }, log), ME)).rejects.toThrow(/signed with a key other than/);
    expect(log).toEqual([]);
  });
});
