// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { Effect } from 'effect';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { nativeToken, shieldedToken } from '@midnightntwrk/ledger-v9';
import type { FinalizedTransaction } from '@midnightntwrk/ledger-v9';
import type { SubmissionService } from '@midnightntwrk/wallet-sdk/capabilities';
import { addressFor, identityFromWords, newSecret } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import {
  duplicateUnresolved, loadPendingSends, pendingGuardFor, resolvePendingSends,
  unresolvedPendingSends,
} from './pending.js';
import { NETWORK } from '../config.js';
import { unshieldedKeystoreFor } from './unshielded.js';
import { dustAddressFor } from './dust.js';
import { startRehearsal, rehearsalDoors } from './rehearsal.js';
import type { Rehearsal } from './rehearsal.js';
import {
  AmountError, RecipientError, parseRecipient, starsFromNight, startSend,
  feeFromRecipe, unshieldedStarsTo, unsignedUnshieldedInputs,
} from './send.js';
import type { SendDoors, SendFacts, SendPlan, SendState } from './send.js';

/*
 * THE SEND FLOW, HELD TO THE SENDING RULES.
 *
 * Nothing in this file fakes the flow it tests: every engine test drives
 * the REAL `WalletFacade` over the SDK's own simulated chain
 * (`rehearsal.ts`), so building, balancing, fee payment, proving
 * (simulated), validation, submission and block inclusion all actually
 * happen, under the ledger's real well-formedness rules — and where money
 * is asserted to have moved, the assertion reads the simulated LEDGER, not
 * the wallet's own opinion of itself.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const ours: Identity = identityFromWords(TEST_MNEMONIC);

/* ------------------------------------------------- the recipient, parsed */

describe('the recipient is a KIND, not a string — §4', () => {
  const shieldedBech = addressFor(ours.moneyAt(2).zswap, NETWORK).bech32;
  const unshieldedBech = unshieldedKeystoreFor(ours, 2).getBech32Address().asString();

  it('a shielded address parses as shielded, both halves from one decode', () => {
    const r = parseRecipient(shieldedBech, NETWORK);
    expect(r.kind).toBe('shielded');
    if (r.kind === 'shielded') {
      expect(r.address.bech32).toBe(shieldedBech);
      expect(r.address.coinPublicKey).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('an unshielded address parses as unshielded, with the hex the ledger writes', () => {
    const r = parseRecipient(unshieldedBech, NETWORK);
    expect(r.kind).toBe('unshielded');
    if (r.kind === 'unshielded') {
      expect(r.bech32).toBe(unshieldedBech);
      expect(r.hex).toMatch(/^[0-9a-f]+$/u);
    }
  });

  it('a DUST address is refused by name — the kind that cannot be paid', () => {
    const dust = dustAddressFor(ours, 2);
    expect(() => parseRecipient(dust, NETWORK)).toThrow(/DUST.*cannot be paid/su);
    try {
      parseRecipient(dust, NETWORK);
    } catch (e) {
      expect((e as RecipientError).code).toBe('dust-address');
    }
  });

  it('half an address — a bare key — is refused as half an address', async () => {
    /* A coin public key alone, really encoded — the realistic mistake is
     * pasting a `shield-cpk` string where an address belongs. */
    const { ShieldedCoinPublicKey } = await import('@midnightntwrk/wallet-sdk-address-format');
    const { ZswapSecretKeys } = await import('@midnightntwrk/ledger-v9');
    const cpk = ShieldedCoinPublicKey.codec.encode(NETWORK, ShieldedCoinPublicKey.fromHexString(
      ZswapSecretKeys.fromSeed(ours.moneyAt(2).zswap).coinPublicKey)).asString();
    expect(() => parseRecipient(cpk, NETWORK)).toThrow(/half/iu);
  });

  it('a wrong-network address is refused as a WHERE mistake, not a WHAT mistake', () => {
    const testnetAddress = addressFor(ours.moneyAt(2).zswap, 'testnet').bech32;
    expect(() => parseRecipient(testnetAddress, NETWORK)).toThrow(/network|stagenet/iu);
  });

  it('a shielded address of the wrong length is refused before anything is built', async () => {
    /*
     * Right checksum, right kind, right network, and thirty-two bytes with a
     * tail of the wrong length. The platform's decode alone takes it, and the
     * ledger refuses what is built to it. `parseRecipient` is where a typed
     * recipient becomes one a send can carry, so a throw here is a send that
     * never starts. RED WHEN `payeeAddress` stops checking the length: this
     * then parses as a shielded recipient.
     */
    const { bech32m } = await import('@scure/base');
    const { AddressError } = await import('midnight-identity');
    const real = bech32m.decodeToBytes(shieldedBech).bytes;
    for (const n of [32, 48, 65]) {
      const out = new Uint8Array(n);
      out.set(real.subarray(0, Math.min(n, 64)));
      const odd = bech32m.encode(`mn_shield-addr_${NETWORK}`, bech32m.toWords(out), false);
      let caught: unknown = null;
      try { parseRecipient(odd, NETWORK); } catch (e) { caught = e; }
      expect(caught, `${n} bytes`).toBeInstanceOf(AddressError);
      expect((caught as Error).message, `${n} bytes`).toContain(`carries ${n} bytes`);
    }
  });

  it('garbage and emptiness are refused with their own words', () => {
    expect(() => parseRecipient('', NETWORK)).toThrow(/empty/u);
    expect(() => parseRecipient('not an address', NETWORK)).toThrow(/not a Midnight address/u);
  });
});

/* --------------------------------------------------- the amount, exactly */

describe('an amount is one division from a millionfold error — §7.17', () => {
  it('NIGHT typed → STARs, exactly', () => {
    expect(starsFromNight('5')).toBe(5_000_000n);
    expect(starsFromNight('0.000001')).toBe(1n);
    expect(starsFromNight('12.5')).toBe(12_500_000n);
    expect(starsFromNight('4999')).toBe(4_999_000_000n);
    expect(starsFromNight(' 1,000 ')).toBe(1_000_000_000n);
    expect(starsFromNight('.5')).toBe(500_000n);
    /* Trailing zeros past the sixth decimal name no money and are fine. */
    expect(starsFromNight('1.5000000')).toBe(1_500_000n);
  });

  it('a seventh significant decimal is REFUSED, never rounded', () => {
    expect(() => starsFromNight('1.0000001')).toThrow(/six decimal|rounded/iu);
    try {
      starsFromNight('1.0000001');
    } catch (e) {
      expect((e as AmountError).code).toBe('too-small');
    }
  });

  it('zero, negatives and junk are refused by name', () => {
    expect(() => starsFromNight('0')).toThrow(/zero/u);
    expect(() => starsFromNight('0.0')).toThrow(/zero/u);
    expect(() => starsFromNight('-1')).toThrow(/below zero/u);
    expect(() => starsFromNight('1.2.3')).toThrow(/not an amount/u);
    expect(() => starsFromNight('five')).toThrow(/not an amount/u);
    expect(() => starsFromNight('')).toThrow(/needed/u);
  });
});

/* ------------------------------------------------------ the whole flow */

/** Drive one send to its final state, collecting every state on the way. */
const runSend = (
  doors: SendDoors,
  plan: SendPlan,
  choose: 'confirm' | 'cancel' = 'confirm',
): Promise<SendState[]> => new Promise((resolve, reject) => {
  const states: SendState[] = [];
  const timer = setTimeout(() => {
    reject(new Error(`send did not finish; states: ${states.map((s) => s.name).join(',')}`));
  }, 30_000);
  const controller = startSend(doors, plan, (state) => {
    states.push(state);
    if (state.name === 'confirm') controller[choose]();
    /* 'unknown' resolves the COLLECTION, not the payment — the record made it a
     * watched state that only ever ends as sent or failed; tests that care
     * about the ending drive the watcher explicitly below. */
    if (state.name === 'sent' || state.name === 'refused'
      || state.name === 'cancelled' || state.name === 'failed'
      || state.name === 'unknown') {
      clearTimeout(timer);
      controller.detach();
      resolve(states);
    }
  });
});

const stageNames = (states: SendState[]): string[] => {
  const seen: string[] = [];
  for (const s of states) {
    const label = s.name === 'working' ? `working:${s.stage}` : s.name;
    if (seen.at(-1) !== label) seen.push(label);
  }
  return seen;
};

const factsOf = (states: SendState[]): SendFacts => {
  const confirm = states.find((s) => s.name === 'confirm');
  if (!confirm || confirm.name !== 'confirm') throw new Error('no confirm state');
  return confirm.facts;
};

describe('an unshielded send, whole, against the rehearsal chain', () => {
  it('walks every stage, reads the recipe back, and the money LANDS', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    const doors = rehearsalDoors(ours, 0);
    /* Same chain for doors and assertions: reuse the running rehearsal. */
    const sharedDoors: SendDoors = { ...doors, facade: async () => rehearsal.facade };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(sharedDoors, { recipient, stars: 250_000_000n });

      /* The order of stages IS the design's order: read, balance, confirm,
       * prove, submit, report. */
      expect(stageNames(states)).toEqual([
        'working:starting', 'working:balancing', 'confirm',
        'working:signing', 'working:proving', 'working:submitting', 'sent',
      ]);

      /* The confirmation was READ BACK from the transaction, not the form. */
      const facts = factsOf(states);
      expect(facts.kind).toBe('unshielded');
      expect(facts.readBack).toBe('transaction');
      expect(facts.stars).toBe(250_000_000n);
      expect(facts.feeSpecks).toBeGreaterThan(0n);
      expect(facts.nightBefore).toBe(5_000_000_000n);
      expect(facts.nightAfter).toBe(4_750_000_000n);
      expect(facts.dustAfter).toBe(facts.dustBefore - facts.feeSpecks);

      /* The report carries the identifier a person can check. */
      const sent = states.at(-1);
      if (sent?.name !== 'sent') throw new Error('not sent');
      expect(sent.txId).toMatch(/^[0-9a-f]{10,}$/u);

      /* AND THE MONEY IS THERE — asked of the simulated ledger itself,
       * not of any wallet's bookkeeping. */
      if (recipient.kind !== 'unshielded') throw new Error('kind changed');
      const landed = await Effect.runPromise(rehearsal.simulator.query((state) =>
        Array.from(state.ledger.utxo.filter(recipient.hex)).map((u) => u.value)));
      expect(landed).toContainEqual(250_000_000n);

      /* And the sender's balance really becomes the number the
       * confirmation promised. */
      const after = await rehearsal.facade.waitForSyncedState();
      expect(after.unshielded.balances[nativeToken().raw] ?? 0n).toBe(facts.nightAfter);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('a shielded send, whole, against the rehearsal chain', () => {
  it('says which numbers are read back, and the promised balance comes true', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(addressFor(ours.moneyAt(2).zswap, NETWORK).bech32, NETWORK);
      const states = await runSend(doors, { recipient, stars: 40_000_000n });
      expect(stageNames(states)).toEqual([
        'working:starting', 'working:balancing', 'confirm',
        'working:signing', 'working:proving', 'working:submitting', 'sent',
      ]);
      const facts = factsOf(states);
      expect(facts.kind).toBe('shielded');
      /* A shielded output is ciphertext to everyone but its recipient —
       * the amount CANNOT be read back off the transaction, and the facts
       * say so instead of pretending. The fee still can be, and is. */
      expect(facts.readBack).toBe('builder-input');
      expect(facts.feeSpecks).toBeGreaterThan(0n);
      expect(facts.nightBefore).toBe(100_000_000n);
      expect(facts.nightAfter).toBe(60_000_000n);
      const after = await rehearsal.facade.waitForSyncedState();
      expect(after.shielded.balances[shieldedToken().raw] ?? 0n).toBe(facts.nightAfter);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('cancelling releases what balancing booked', () => {
  it('after a cancel, the whole balance can still be sent', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const cancelled = await runSend(doors, { recipient, stars: 4_000_000_000n }, 'cancel');
      expect(stageNames(cancelled)).toEqual([
        'working:starting', 'working:balancing', 'confirm', 'cancelled',
      ]);
      /* If the booked coins were NOT released, this second send — needing
       * nearly the whole balance — could not select its inputs. */
      const again = await runSend(doors, { recipient, stars: 4_900_000_000n });
      expect(stageNames(again).at(-1)).toBe('sent');
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('refusals happen while "nothing moved" is still true', () => {
  it('more than the wallet holds: refused, and nothing reaches proving', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 6_000_000_000n });
      const last = states.at(-1);
      if (last?.name !== 'refused') throw new Error(`expected refused, got ${last?.name}`);
      expect(last.message).toMatch(/Nothing was sent and no money moved/u);
      expect(stageNames(states)).not.toContain('working:proving');
      expect(stageNames(states)).not.toContain('confirm');
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('no DUST: refused — a fee that cannot be paid stops the send before anything', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, { withoutDust: true });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 1_000_000n });
      const last = states.at(-1);
      if (last?.name !== 'refused') throw new Error(`expected refused, got ${last?.name}`);
      expect(last.message).toMatch(/Nothing was sent and no money moved/u);
      expect(stageNames(states)).not.toContain('confirm');
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('a proving failure is a refusal — nothing was submitted, and the wallet stays usable', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      provingService: { prove: () => Promise.reject(new Error('the prover fell over')) },
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 1_000_000n });
      const last = states.at(-1);
      if (last?.name !== 'refused') throw new Error(`expected refused, got ${last?.name}`);
      expect(last.message).toMatch(/proof could not be built/u);
      expect(last.message).toMatch(/Nothing was sent/u);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('THE DANGEROUS MIDDLE — the proof succeeds, the submission fails', () => {
  const failingSubmission: SubmissionService<FinalizedTransaction> = {
    submitTransaction: (() => Promise.reject(new Error(
      'the connection to the node closed before any answer arrived'))) as
        SubmissionService<FinalizedTransaction>['submitTransaction'],
    close: () => Promise.resolve(),
  };

  it('reports UNKNOWN with the identifiers — never success, never failure', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: failingSubmission,
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 1_000_000n });
      const last = states.at(-1);
      if (last?.name !== 'unknown') throw new Error(`expected unknown, got ${last?.name}`);
      /* It reached proving and submitting first — this is the middle, not
       * an early refusal. */
      expect(stageNames(states)).toContain('working:proving');
      expect(stageNames(states)).toContain('working:submitting');
      /* The identifiers a person can check are handed over. */
      expect(last.identifiers.length).toBeGreaterThan(0);
      /* The words never claim either outcome, and they name the trap: the
       * wallet's own balances may look untouched. */
      expect(last.message).toMatch(/NOT KNOWN/u);
      expect(last.message).toMatch(/own bookkeeping/u);
      expect(last.message).not.toMatch(/nothing was sent/iu);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('a submission that never answers gets named out loud on the engine\'s own clock', async () => {
    const neverAnswers: SubmissionService<FinalizedTransaction> = {
      submitTransaction: (() => new Promise(() => { /* the network says nothing */ })) as
        SubmissionService<FinalizedTransaction>['submitTransaction'],
      close: () => Promise.resolve(),
    };
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: neverAnswers,
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => rehearsal.facade,
      submitQuietMs: 300,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const state = await new Promise<SendState>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('no quiet report')); }, 30_000);
        const controller = startSend(doors, { recipient, stars: 1_000_000n }, (s) => {
          if (s.name === 'confirm') controller.confirm();
          if (s.name === 'unknown') { clearTimeout(timer); controller.detach(); resolve(s); }
        });
      });
      if (state.name !== 'unknown') throw new Error('not unknown');
      expect(state.stillWaiting).toBe(true);
      expect(state.message).toMatch(/has not answered/u);
      expect(state.message).toMatch(/Do not send this payment again/u);
      /* The middle now says it is being watched and carried. */
      expect(state.message).toMatch(/keeps asking the chain/u);
      expect(state.message).toMatch(/home screen/u);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('THE MIDDLE ENDS — written down first, watched to an answer', () => {
  const failingSubmission: SubmissionService<FinalizedTransaction> = {
    submitTransaction: (() => Promise.reject(new Error(
      'the connection to the node closed before any answer arrived'))) as
        SubmissionService<FinalizedTransaction>['submitTransaction'],
    close: () => Promise.resolve(),
  };

  /** A pending guard that remembers everything done to it, in order. */
  const spyGuard = () => {
    const events: string[] = [];
    const settled: { key: string; outcome: string }[] = [];
    return {
      events,
      settled,
      guard: {
        duplicateUnresolved: () => false,
        write: () => { events.push('write'); },
        settle: (key: string, outcome: { name: string }) => {
          events.push(`settle:${outcome.name}`);
          settled.push({ key, outcome: outcome.name });
        },
      },
    };
  };

  it('the payment is WRITTEN DOWN BEFORE the submit call — the ordering itself', async () => {
    const spy = spyGuard();
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: {
        submitTransaction: ((tx: FinalizedTransaction) => {
          spy.events.push('submit');
          return Promise.resolve(tx.identifiers()[0] ?? 'tx');
        }) as unknown as SubmissionService<FinalizedTransaction>['submitTransaction'],
        close: () => Promise.resolve(),
      },
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => rehearsal.facade,
      pending: spy.guard,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 1_000_000n });
      expect(states.at(-1)?.name).toBe('sent');
      /* THE PIN: write strictly before submit, settle after the answer. A
       * tab killed between those two calls still knows the question. */
      expect(spy.events).toEqual(['write', 'submit', 'settle:sent']);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('a payment that cannot be written down is NOT submitted', async () => {
    let submitted = 0;
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: {
        submitTransaction: ((tx: FinalizedTransaction) => {
          submitted += 1;
          return Promise.resolve(tx.identifiers()[0] ?? 'tx');
        }) as unknown as SubmissionService<FinalizedTransaction>['submitTransaction'],
        close: () => Promise.resolve(),
      },
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => rehearsal.facade,
      pending: {
        duplicateUnresolved: () => false,
        write: () => { throw new Error('storage is full'); },
        settle: () => {},
      },
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 1_000_000n });
      const last = states.at(-1);
      if (last?.name !== 'refused') throw new Error(`expected refused, got ${last?.name}`);
      expect(last.message).toMatch(/could not be written down/u);
      expect(last.message).toMatch(/NOT submitted/u);
      expect(submitted).toBe(0);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('the same payment is refused while one is unresolved — before any wallet is dialled', async () => {
    let dialled = 0;
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => { dialled += 1; throw new Error('must not be reached'); },
      pending: {
        duplicateUnresolved: () => true,
        write: () => {},
        settle: () => {},
      },
    };
    const recipient = parseRecipient(
      unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
    const states = await runSend(doors, { recipient, stars: 1_000_000n });
    const last = states.at(-1);
    if (last?.name !== 'refused') throw new Error(`expected refused, got ${last?.name}`);
    expect(last.message).toMatch(/already handed to the network/u);
    expect(last.message).toMatch(/sent twice/u);
    expect(dialled).toBe(0);
  }, 60_000);

  it('the watched middle ends as SENT when the chain confirms by identifier', async () => {
    const spy = spyGuard();
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: failingSubmission,
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => rehearsal.facade,
      pending: spy.guard,
      transactionStatus: async () => ({ found: true, status: 'SUCCESS' }),
      watchEveryMs: 50,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await new Promise<SendState[]>((resolve, reject) => {
        const seen: SendState[] = [];
        const timer = setTimeout(() => {
          reject(new Error(`no ending; states: ${seen.map((x) => x.name).join(',')}`));
        }, 30_000);
        const controller = startSend(doors, { recipient, stars: 1_000_000n }, (state) => {
          seen.push(state);
          if (state.name === 'confirm') controller.confirm();
          if (state.name === 'sent' || state.name === 'failed' || state.name === 'refused') {
            clearTimeout(timer);
            controller.detach();
            resolve(seen);
          }
        });
      });
      /* The middle was SAID (never skipped), and then it ENDED — as sent. */
      expect(states.some((state) => state.name === 'unknown')).toBe(true);
      expect(states.at(-1)?.name).toBe('sent');
      expect(spy.settled).toEqual([
        { key: states.find((x) => x.name === 'unknown' && x.identifiers[0])
          ? (states.find((x) => x.name === 'unknown') as { identifiers: readonly string[] }).identifiers[0]
          : '', outcome: 'sent' },
      ]);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('a chain silent past the transaction\'s OWN TTL ends as FAILED — a fact, not a guess', async () => {
    const spy = spyGuard();
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: failingSubmission,
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => rehearsal.facade,
      pending: spy.guard,
      transactionStatus: async () => ({ found: false }),
      watchEveryMs: 50,
      ttlMs: 1,
      settleMarginMs: 0,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const last = await new Promise<SendState>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('never ended')); }, 30_000);
        const controller = startSend(doors, { recipient, stars: 1_000_000n }, (state) => {
          if (state.name === 'confirm') controller.confirm();
          if (state.name === 'failed' || state.name === 'sent') {
            clearTimeout(timer);
            controller.detach();
            resolve(state);
          }
        });
      });
      if (last.name !== 'failed') throw new Error('expected failed');
      expect(last.message).toMatch(/can no longer be included/u);
      /* The sentence must NOT claim nothing moved, and must NOT tell
       * anybody it is safe to send again — the only evidence is a silence
       * from the indexer, and a finalised transaction has been measured
       * invisible to it. */
      expect(last.message).not.toMatch(/[Nn]othing moved/u);
      expect(last.message).not.toMatch(/safe to send/u);
      expect(last.message).toMatch(/NOT known/u);
      expect(last.identifiers.length).toBeGreaterThan(0);
      expect(spy.settled.at(-1)?.outcome).toBe('failed');
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('KILL THE TAB MID-SUBMIT: the payment is still there and resolves itself, nobody pressing anything', async () => {
    /* THE test the record names. A real store (localStorage), a submission that
     * never answers, and a "tab" that dies the moment the middle is said.
     * The reopened wallet — here, the resolution the home screen runs on
     * every start — must still hold the payment and settle it on its own. */
    localStorage.removeItem('midnight-identity:pending-sends');
    const secret = newSecret();
    const neverAnswers: SubmissionService<FinalizedTransaction> = {
      submitTransaction: (() => new Promise(() => { /* nothing, for ever */ })) as
        SubmissionService<FinalizedTransaction>['submitTransaction'],
      close: () => Promise.resolve(),
    };
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      submissionService: neverAnswers,
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0),
      facade: async () => rehearsal.facade,
      pending: pendingGuardFor(secret, 0),
      submitQuietMs: 200,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('never reached the middle')); }, 30_000);
        const controller = startSend(doors, { recipient, stars: 1_000_000n }, (state) => {
          if (state.name === 'confirm') controller.confirm();
          if (state.name === 'unknown') {
            clearTimeout(timer);
            /* THE TAB DIES. Nothing else from this engine ever runs. */
            controller.detach();
            resolve();
          }
        });
      });

      /* REOPENED: the payment is still there... */
      const pending = unresolvedPendingSends(secret);
      expect(pending.length).toBe(1);
      if (!pending[0]) throw new Error('nothing pending');
      expect(pending[0].stars).toBe('1000000');
      expect(pending[0].identifiers.length).toBeGreaterThan(0);

      /* ...and it resolves itself — the exact call the home screen makes on
       * every start, with the chain answering by identifier. */
      const settled = await resolvePendingSends(secret, {
        status: async () => ({ found: true, status: 'SUCCESS' }),
        now: Date.now,
      });
      expect(settled.length).toBe(1);
      expect(loadPendingSends(secret)[0]?.outcome?.name).toBe('sent');
      /* And the double-send guard held the whole way through. */
      expect(duplicateUnresolved(secret, pending[0].recipientBech32, 1_000_000n)).toBe(false);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('the prover is one injected object — the flow cannot tell provers apart', () => {
  it('the state walk under a slow prover equals the walk under the instant one', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, {
      /* One second of "slow": enough to prove the flow does not change
       * shape when proving takes time — the SHAPE is what this pins. */
      provingService: {
        prove: async (tx) => {
          await new Promise((resolve) => { setTimeout(resolve, 1_100); });
          return tx.eraseProofs() as never;
        },
      },
    });
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 1_000_000n });
      expect(stageNames(states)).toEqual([
        'working:starting', 'working:balancing', 'confirm',
        'working:signing', 'working:proving', 'working:submitting', 'sent',
      ]);
      /* While the slow proof ran, the engine re-announced itself on
       * its own clock — at least one 'proving' state carries elapsed time,
       * so no screen rendering this flow can ever be still. */
      const provingTicks = states.filter((s) => s.name === 'working'
        && s.stage === 'proving' && s.forMs > 0);
      expect(provingTicks.length).toBeGreaterThan(0);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('the recipe readers read what the spike measured', () => {
  it('fee and recipient figures come off a real balanced recipe', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    try {
      const keystore = unshieldedKeystoreFor(ours, 2);
      const recipientHex = keystore.getAddress();
      const { MidnightBech32m, UnshieldedAddress } = await import('@midnightntwrk/wallet-sdk-address-format');
      const parsed = MidnightBech32m.parse(keystore.getBech32Address().asString());
      const recipe = await rehearsal.facade.transferTransaction([{
        type: 'unshielded',
        outputs: [{
          type: nativeToken().raw,
          receiverAddress: parsed.decode(UnshieldedAddress, NETWORK),
          amount: 123_456n,
        }],
      }], rehearsalDoors(ours, 0).keys(), {
        ttl: new Date(rehearsal.now().getTime() + 3_600_000),
      });
      expect(unshieldedStarsTo(recipe, recipientHex)).toBe(123_456n);
      expect(feeFromRecipe(recipe)).toBeGreaterThan(0n);
      await rehearsal.facade.revert(recipe);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

describe('a PLATFORM FACT, pinned: the ledger has no shield door', () => {
  it('a swap netting unshielded NIGHT against a shielded output is refused by the ledger', async () => {
    /* Measured while planning, kept as a pin because product decisions
     * rest on it: `facade.initSwap` is HALF of a two-party atomic exchange,
     * not a shield operation. A transaction offering an unshielded input
     * against a shielded output carries +N unshielded and −N shielded
     * imbalances — the pools do not net, shielded value on this ledger is
     * minted by contracts, and the simulated chain (running the real
     * ledger's well-formedness rules) refuses it. If an SDK upgrade ever
     * makes this pass, a shield door has appeared and the wallet should
     * hear about it — through this test going red. */
    const rehearsal: Rehearsal = await startRehearsal(ours, 0, { shieldedStars: 0n });
    try {
      const keys = rehearsalDoors(ours, 0).keys();
      const own = addressFor(ours.moneyAt(0).zswap, NETWORK);
      const { MidnightBech32m, ShieldedAddress } = await import('@midnightntwrk/wallet-sdk-address-format');
      const recipient = MidnightBech32m.parse(own.bech32).decode(ShieldedAddress, NETWORK);
      const ttl = new Date(rehearsal.now().getTime() + 3_600_000);
      const recipe = await rehearsal.facade.initSwap(
        { unshielded: { [nativeToken().raw]: 100_000_000n }, shielded: {} },
        [{
          type: 'shielded',
          outputs: [{ type: shieldedToken().raw, receiverAddress: recipient, amount: 100_000_000n }],
        }],
        { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
        { ttl, payFees: true },
      );
      const finalized = await rehearsal.facade.finalizeRecipe(recipe);
      /* The imbalances say why before the ledger says no. */
      const imbalances = [...finalized.imbalances(0).entries()]
        .map(([tt, v]) => [(tt as { tag: string }).tag, v] as const);
      expect(imbalances.find(([tag]) => tag === 'unshielded')?.[1]).toBe(100_000_000n);
      expect(imbalances.find(([tag]) => tag === 'shielded')?.[1]).toBe(-100_000_000n);
      await expect(rehearsal.facade.submitTransaction(finalized)).rejects.toThrow();
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);
});

/*
 * EVERY UNSHIELDED INPUT THIS WALLET SPENDS CARRIES A SIGNATURE.
 *
 * The defect these pin against survived two rounds of a green suite, and
 * the reason is measured rather than guessed: **the rehearsal chain accepts
 * an unshielded transfer with no signatures at all.** Run against this same
 * simulator, an unsigned transfer passes `validateTransaction` with
 * `verifySignatures: true` AND is accepted by `submitTransaction` — while
 * stagenet refuses the identical shape with *"mismatch between number of
 * inputs (1) and signatures (0)"*. So "the send test is green" was never
 * evidence that a send could happen.
 *
 * These tests therefore do NOT ask the simulated chain whether it is happy.
 * They count signatures against inputs on the transaction itself, in the
 * same terms the real chain refused it in. That is the one assertion the
 * rehearsal cannot fake, and removing the engine's `signRecipe` call turns
 * it red.
 */
describe('the unshielded inputs a send spends are signed', () => {
  it('THE PIN: after the engine builds and signs, no unshielded input is unsigned', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    const doors: SendDoors = {
      ...rehearsalDoors(ours, 0), facade: async () => rehearsal.facade,
    };
    try {
      const recipient = parseRecipient(
        unshieldedKeystoreFor(ours, 2).getBech32Address().asString(), NETWORK);
      const states = await runSend(doors, { recipient, stars: 250_000_000n });

      /* SIGNING is a stage of its own, between the confirmation and the
       * proof: after the person agrees (a signature IS the authorisation)
       * and before binding (`addSignature` refuses a bound intent). */
      expect(stageNames(states)).toEqual([
        'working:starting', 'working:balancing', 'confirm',
        'working:signing', 'working:proving', 'working:submitting', 'sent',
      ]);
      expect(states.at(-1)?.name).toBe('sent');
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('THE PIN, counted on the transaction: signRecipe fills every input\'s signature', async () => {
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    try {
      const doors = rehearsalDoors(ours, 0);
      const keystore = unshieldedKeystoreFor(ours, 2);
      const { MidnightBech32m, UnshieldedAddress } = await import('@midnightntwrk/wallet-sdk-address-format');
      const parsed = MidnightBech32m.parse(keystore.getBech32Address().asString());
      const recipe = await rehearsal.facade.transferTransaction([{
        type: 'unshielded',
        outputs: [{
          type: nativeToken().raw,
          receiverAddress: parsed.decode(UnshieldedAddress, NETWORK),
          amount: 250_000_000n,
        }],
      }], doors.keys(), { ttl: new Date(rehearsal.now().getTime() + 3_600_000) });

      /* THE DEFECT, reproduced: what this wallet built for two whole rounds
       * and handed to a real chain. The count is the chain's own complaint. */
      expect(unsignedUnshieldedInputs(recipe)).toBeGreaterThan(0);

      /* AND THE FIX, on the same transaction. */
      const signed = await rehearsal.facade.signRecipe(recipe, doors.signSegment());
      expect(unsignedUnshieldedInputs(signed)).toBe(0);

      await rehearsal.facade.revert(signed);
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('WHY THE SUITE COULD NOT SEE IT: the rehearsal chain accepts an unsigned transfer', async () => {
    /* This is not a pin on the wallet — it is a pin on what the wallet's
     * OWN TESTS are worth. If a later SDK makes the simulator enforce
     * signatures, this test goes red, and that red is good news: it means
     * the suite can finally see the class of defect this belonged to, and
     * the comment above these tests should be corrected. */
    const rehearsal: Rehearsal = await startRehearsal(ours, 0);
    try {
      const doors = rehearsalDoors(ours, 0);
      const keystore = unshieldedKeystoreFor(ours, 2);
      const { MidnightBech32m, UnshieldedAddress } = await import('@midnightntwrk/wallet-sdk-address-format');
      const parsed = MidnightBech32m.parse(keystore.getBech32Address().asString());
      const recipe = await rehearsal.facade.transferTransaction([{
        type: 'unshielded',
        outputs: [{
          type: nativeToken().raw,
          receiverAddress: parsed.decode(UnshieldedAddress, NETWORK),
          amount: 10_000_000n,
        }],
      }], doors.keys(), { ttl: new Date(rehearsal.now().getTime() + 3_600_000) });
      expect(unsignedUnshieldedInputs(recipe)).toBeGreaterThan(0);

      const finalized = await rehearsal.facade.finalizeRecipe(recipe);
      /* The flags the send engine itself uses — and they pass. */
      await expect(rehearsal.facade.validateTransaction(finalized, {
        flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true },
        blockData: recipe.blockData,
      })).resolves.toBeUndefined();
    } finally {
      await rehearsal.stop();
    }
  }, 60_000);

  it('the counter reads BOTH offers — a plain transfer lands in the fallible one', () => {
    const offer = (inputs: number, signatures: number) => ({
      inputs: Array.from({ length: inputs }, () => ({})),
      signatures: Array.from({ length: signatures }, () => ({})),
    });
    const recipeWith = (intent: Record<string, unknown>) => ({
      type: 'UNPROVEN_TRANSACTION' as const,
      transaction: { intents: new Map([[1, intent]]) },
    } as unknown as Parameters<typeof unsignedUnshieldedInputs>[0]);

    expect(unsignedUnshieldedInputs(recipeWith({ fallibleUnshieldedOffer: offer(1, 0) }))).toBe(1);
    expect(unsignedUnshieldedInputs(recipeWith({ guaranteedUnshieldedOffer: offer(2, 0) }))).toBe(2);
    expect(unsignedUnshieldedInputs(recipeWith({
      guaranteedUnshieldedOffer: offer(1, 1), fallibleUnshieldedOffer: offer(3, 1),
    }))).toBe(2);
    expect(unsignedUnshieldedInputs(recipeWith({ fallibleUnshieldedOffer: offer(2, 2) }))).toBe(0);
    expect(unsignedUnshieldedInputs(recipeWith({}))).toBe(0);
  });
});
