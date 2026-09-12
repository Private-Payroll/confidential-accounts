/**
 * **WHAT A DEVICE COMPOSES, WHAT IT WRITES BACK, AND THE DIFFERENCE BETWEEN
 * THE TWO.**
 *
 * The subject of every case below is one sentence: the signer's own material
 * goes IN to a circuit and never comes back OUT to anything that writes. Two
 * halves of that, and they fail differently:
 *
 *   THE READ   a record composed partly from bytes another party handed back.
 *              What must not survive that is a forged membership path, and its
 *              symptom is a signer who cannot prove they are one.
 *   THE WRITE  the record the scheme puts back after a call that settled.
 *              What must not survive that is a signing key, and its symptom is
 *              nothing at all.
 *
 * **THE SECOND HAS NO SYMPTOM, WHICH IS WHY THE CASES ASSERT ON WHAT REACHED
 * THE STORE RATHER THAN ON WHAT THE WRITE RETURNED.** A `set` that quietly
 * wrote everything it was handed would return exactly what a correct one does.
 */
import { describe, it, expect } from 'vitest';

import {
  derivedPrivateState, signerHalfOf, SignerMaterialHeldInMemory, NO_CONTRACT_ADDRESSED,
  type AccountHalfStore, type SignerMaterial, type StorableHalf,
} from './private-state.js';
import { fromHex, toHex } from '../core/crypto.js';

/** Deterministic thirty-two bytes, so a failure fails the same way twice. */
const bytes32 = (seed: number): string => {
  let out = '';
  for (let i = 0; i < 32; i++) out += ((seed * 31 + i * 7) % 256).toString(16).padStart(2, '0');
  return out;
};

const ADA: SignerMaterial = {
  signingSecret: bytes32(1),
  blinding: bytes32(2),
  scope: bytes32(3),
};

/** Somebody else's, for the cases about a record another party wrote. */
const BRUNO: SignerMaterial = {
  signingSecret: bytes32(41),
  blinding: bytes32(42),
  scope: bytes32(43),
};

const A_CONTRACT = '0200aa'.padEnd(70, '0');
const ANOTHER_CONTRACT = '0200bb'.padEnd(70, '0');
const ID = 'device-side:acc_1';

/**
 * A store that records what it was asked and what it was given.
 *
 * **IT KEEPS THE ADDRESS IT WAS CALLED WITH ON EVERY ENTRY**, because the case
 * about answering under the wrong contract is the one a store that remembered
 * an address could not fail.
 */
const aStore = (initial: unknown = undefined) => {
  const reads: Array<{ address: string; id: string }> = [];
  const writes: Array<{ address: string; id: string; half: StorableHalf }> = [];
  const removed: Array<{ address: string; id: string }> = [];
  const cleared: string[] = [];
  let held = initial;
  const store: AccountHalfStore = {
    get: async (address, id) => { reads.push({ address, id }); return held; },
    set: async (address, id, half) => { writes.push({ address, id, half }); held = half; },
    /*
     * **NO ENTRY IN `writes`, AND THAT IS NOT AN OVERSIGHT.** A removal is not
     * a write of an empty half, and recording it as one would give any case
     * that removes and then reads `writes` a phantom entry it did not cause.
     */
    remove: async (address, id) => { removed.push({ address, id }); held = undefined; },
    clear: async (address) => { cleared.push(address); held = undefined; },
  };
  return { store, reads, writes, removed, cleared, held: () => held };
};

/** The provider as a device would build it, with one signer's material held. */
const aDevice = (opts: { material?: SignerMaterial | null; stored?: unknown } = {}) => {
  const memory = new SignerMaterialHeldInMemory();
  const material = opts.material === undefined ? ADA : opts.material;
  if (material !== null) memory.hold(ID, material);
  const backing = aStore(opts.stored);
  const provider = derivedPrivateState({
    signerMaterial: (id) => memory.for(id),
    accountHalf: backing.store,
  });
  return { provider, memory, ...backing };
};

describe('what a keyring entry becomes when a circuit asks for it', () => {
  /**
   * **THE THREE THE CIRCUIT READS ARE THE THREE THE KEYRING HOLDS, AS BYTES.**
   *
   * RED WHEN: any of the three stops being read from the material it is named
   * for - the field is then some other value of the right width, which is the
   * shape of failure that produces "you are not a signer on this account" from
   * a device with nothing visibly wrong with it. Watched, per field.
   */
  it('reads each of the three off the field it is named for', () => {
    const half = signerHalfOf(ADA);
    expect([toHex(half.secretKey), toHex(half.blinding), toHex(half.scope)])
      .toEqual([ADA.signingSecret, ADA.blinding, ADA.scope]);
  });

  /**
   * **A SCOPE THAT IS NOT THERE IS REFUSED AND IS NOT INVENTED.**
   *
   * Key material sealed before vault scopes were recorded has none. The scope
   * is part of the leaf the signer tree is asked about, so filling one in
   * produces a leaf the account does not hold - and nothing says so, because
   * every check on the device compares values that all came from the same
   * wrong place.
   *
   * RED WHEN: the absence is defaulted to anything at all - the call then
   * returns a half rather than throwing. Watched, against a default of thirty
   * two zero bytes.
   */
  it('REFUSES material written before vault scopes were recorded', () => {
    const { scope: _dropped, ...before } = ADA;
    expect(() => signerHalfOf(before)).toThrow(/vault scopes were recorded/);
  });

  /**
   * **PRESENCE IS NOT TRUTH, AND THIS IS THE CASE THAT SEPARATES THEM.**
   *
   * A field that is present and EMPTY is what a check written the obvious way
   * walks straight past. Thirty-two zero bytes would not do as the subject
   * here: an array of zeroes is truthy, so it is caught either way and the case
   * would be green against the mutation it claims to catch.
   *
   * RED WHEN: the refusal tests the value's truthiness rather than testing the
   * empty string and the absence by name. Watched.
   */
  it('REFUSES a scope that is present and empty, not only one that is absent', () => {
    expect(() => signerHalfOf({ ...ADA, scope: '' })).toThrow(/vault scopes were recorded/);
  });

  /**
   * **THE WIDTH IS CHECKED, BECAUSE THE CIRCUIT'S FAILURE FOR A SHORT KEY IS
   * THE SAME SENTENCE AS ITS FAILURE FOR A WRONG ONE.**
   *
   * RED WHEN: the width check is removed - the short value is carried into the
   * circuit and the refusal that arrives names the signer rather than the key.
   * Watched.
   */
  it('REFUSES a signing key that is not thirty-two bytes, naming the width', () => {
    expect(() => signerHalfOf({ ...ADA, signingSecret: 'aabbcc' }))
      .toThrow(/3 bytes and a signer's is thirty-two/);
  });
});

describe('the record a governed call is handed', () => {
  /**
   * **THE TWO HALVES MEET HERE AND NOWHERE ELSE.**
   *
   * RED WHEN: the composed record takes the signer's three from the store
   * instead of from memory - the assertion on `secretKey` then reports the
   * store's value. Watched, with a store answering with Bruno's.
   */
  it('composes the signer\'s own three with what the account staged', async () => {
    const d = aDevice({ stored: { assetId: new Uint8Array([7]), changeAmount: 500n } });
    d.provider.setContractAddress(A_CONTRACT);

    const record = (await d.provider.get(ID))!;
    expect({
      secretKey: toHex(record.secretKey),
      assetId: record.assetId === undefined ? 'absent' : [...record.assetId].join(),
      changeAmount: record.changeAmount,
    }).toEqual({ secretKey: ADA.signingSecret, assetId: '7', changeAmount: 500n });
  });

  /**
   * **A DEVICE THAT HAS STAGED NOTHING STILL COMPOSES A RECORD, AND THAT IS
   * WHAT LETS A SECOND SIGNER APPROVE.**
   *
   * Approving a round somebody else raised reads the approver's own secret
   * key, blinding and scope and a path through a PUBLIC tree. It reads no
   * salt, no asset and no amount. So the record below is not a partial one: it
   * is a complete record for what an approval does.
   *
   * RED WHEN: the composition refuses, or answers `null`, when the store holds
   * nothing - an account whose approvals only work on the laptop that raised
   * the run is not an account of several people. Watched.
   */
  it('composes a complete record for an approval on a device that has staged nothing', async () => {
    const d = aDevice({ stored: undefined });
    d.provider.setContractAddress(A_CONTRACT);

    const record = (await d.provider.get(ID))!;
    expect([toHex(record.secretKey), toHex(record.blinding), toHex(record.scope)])
      .toEqual([ADA.signingSecret, ADA.blinding, ADA.scope]);
  });

  /**
   * **NO MATERIAL MEANS NO SEAT, AND THE HONEST ANSWER IS NOTHING RATHER THAN
   * A RECORD WITH NOTHING IN IT.**
   *
   * The scheme turns `null` into a refusal naming the record it looked for. A
   * composed record built from no material would instead run the circuit
   * against values that prove nothing, and fail inside it naming none of this.
   *
   * RED WHEN: a missing entry composes a record anyway. Watched.
   */
  it('answers with nothing when this device holds no material for that company', async () => {
    const d = aDevice({ material: null });
    d.provider.setContractAddress(A_CONTRACT);
    expect(await d.provider.get(ID)).toBeNull();
  });

  /**
   * **A RECORD ANOTHER PARTY WROTE CANNOT PUT A MEMBERSHIP PATH INTO A CALL,
   * AND CANNOT PUT A SIGNING KEY INTO ONE EITHER.**
   *
   * The account's half may be kept where somebody else can hand it back. Two
   * fields on this record make a witness answer with a path it was given rather
   * than one it found; a path from before the signer tree moved stops
   * verifying, and the circuit then tells somebody who IS a signer that they
   * are not - durably, with the money fine and no screen able to say why.
   *
   * **ONE ASSERTION OVER ALL THREE**, because they are one property: nothing
   * the store said reached the record.
   *
   * RED WHEN: the store's answer is spread in without being stripped - the pin
   * arrives, the flag arrives, and the secret is Bruno's. Watched, all three.
   */
  it('takes no forged path and no key from what the store handed back', async () => {
    const d = aDevice({
      stored: {
        secretKey: new Uint8Array(32).fill(9),
        blinding: new Uint8Array(32).fill(9),
        scope: new Uint8Array(32).fill(9),
        pinnedPath: { leaf: new Uint8Array(32), path: [] },
        pinAnyLeaf: true,
        assetId: new Uint8Array([7]),
      },
    });
    d.provider.setContractAddress(A_CONTRACT);

    const record = (await d.provider.get(ID))!;
    expect({
      pinnedPath: record.pinnedPath,
      pinAnyLeaf: 'pinAnyLeaf' in record,
      secretKey: toHex(record.secretKey),
    }).toEqual({ pinnedPath: null, pinAnyLeaf: false, secretKey: ADA.signingSecret });
  });
});

describe('what the write-back after a settled call is allowed to keep', () => {
  /**
   * **THE ONE CASE THIS FILE EXISTS FOR.**
   *
   * The scheme puts the record a call ran with back into the store the call was
   * configured against, after a transaction that succeeded entirely. Nothing
   * above it calls that line, nothing logs it, and it happens after the money
   * has moved and the screen has said so. **A store handed the whole record
   * acquires a signing key on the first successful call and nothing goes red.**
   *
   * Asserted on what REACHED the store, not on what the write returned: a
   * write that kept everything returns exactly what a correct one does.
   *
   * RED WHEN: the drop keeps everything, or keeps any one of the five. Watched,
   * with the drop replaced by the identity.
   */
  it('writes the account half and none of the five', async () => {
    const d = aDevice();
    d.provider.setContractAddress(A_CONTRACT);

    await d.provider.set(ID, {
      secretKey: new Uint8Array(32).fill(1),
      blinding: new Uint8Array(32).fill(2),
      scope: new Uint8Array(32).fill(3),
      pinnedPath: { leaf: new Uint8Array(32), path: [] },
      pinAnyLeaf: true,
      assetId: new Uint8Array([7]),
      changeAmount: 500n,
    } as never);

    expect(Object.keys(d.writes[0]!.half).sort()).toEqual(['assetId', 'changeAmount']);
  });

  /**
   * **A NAME CHECK CANNOT SEE A SECRET WRITTEN UNDER AN ALLOWED NAME, AND THIS
   * IS THE CASE FOR THE THING THAT CAN.**
   *
   * The account's asset blinding is thirty-two bytes and is MEANT to be
   * written. A record whose asset blinding is this signer's signing key
   * therefore satisfies every check that reads a list of field names - the key
   * set written is exactly the allowed one - and puts a signing key in the
   * store under a heading nobody would look at.
   *
   * **THAT IS NOT A SHAPE SOMEBODY IMAGINED. IT IS THE ONE CHANGE FOUND TO
   * LEAVE EVERY OTHER CASE OVER THIS FILE GREEN**, which is why the answer is a
   * refusal in the product rather than a further case here.
   *
   * RED WHEN: the comparison against this device's own material is removed -
   * the write then succeeds and the store holds the key. Watched.
   */
  it('REFUSES a write whose allowed field carries the signer\'s own key', async () => {
    const d = aDevice();
    d.provider.setContractAddress(A_CONTRACT);

    await expect(d.provider.set(ID, {
      assetBlinding: fromHex(ADA.signingSecret),
      assetId: new Uint8Array([7]),
    } as never)).rejects.toThrow(/own key material to storage under the name "assetBlinding"/);
    expect(d.writes).toEqual([]);
  });

  /**
   * **AND IT IS A WRITE, NOT A SILENT DROP.** A `set` that kept nothing at all
   * would satisfy the case above and would lose the salt four governance
   * circuits recompute a round's identity from.
   *
   * RED WHEN: `set` stops calling the store. Watched.
   */
  it('does write the account half rather than discarding it', async () => {
    const d = aDevice();
    d.provider.setContractAddress(A_CONTRACT);
    await d.provider.set(ID, { assetId: new Uint8Array([7]) } as never);

    expect(d.writes.map((w) => [w.address, w.id, [...(w.half.assetId ?? [])].join()]))
      .toEqual([[A_CONTRACT, ID, '7']]);
  });
});

describe('which company a read is about', () => {
  /**
   * **THE ADDRESS IS PASSED DOWN AND NOT REMEMBERED UNDERNEATH.**
   *
   * The scheme sets the address before every read and write it makes. A store
   * that kept its own copy would answer from whichever contract was addressed
   * last, which is another company's record under this company's name.
   *
   * RED WHEN: the address stops being handed to the store - both reads then
   * name the same one. Watched.
   */
  it('asks the store under the address the call was set to, each time', async () => {
    const d = aDevice();
    d.provider.setContractAddress(A_CONTRACT);
    await d.provider.get(ID);
    d.provider.setContractAddress(ANOTHER_CONTRACT);
    await d.provider.get(ID);

    expect(d.reads.map((r) => r.address)).toEqual([A_CONTRACT, ANOTHER_CONTRACT]);
  });

  /**
   * **AND A READ BEFORE ANY ADDRESS IS SET IS REFUSED RATHER THAN GUESSED.**
   *
   * RED WHEN: the missing address falls back to anything - the read then
   * succeeds and answers about a company nobody named. Watched.
   */
  it('REFUSES to read or write before it is told which company', async () => {
    const d = aDevice();
    await expect(d.provider.get(ID)).rejects.toThrow(NO_CONTRACT_ADDRESSED);
    await expect(d.provider.set(ID, {} as never)).rejects.toThrow(NO_CONTRACT_ADDRESSED);
  });
});

describe('the ways a record could leave this device, and the fact that none of them do', () => {
  /**
   * **COMPOSING IS WHAT A READ HERE DOES, SO AN EXPORT OF A RECORD IS AN
   * EXPORT OF A SIGNING KEY** - the one thing this whole file exists to make
   * impossible, available in a single call to anything holding this object.
   * An import is the same hazard in the other direction: a record chosen by
   * somebody else, including the two fields that forge a membership path.
   *
   * The four maintenance-authority methods are refused for a different reason
   * and the message says which: that authority is not something a browser holds
   * here, so a device keeping one would be a durable place for key material
   * that nothing in this design has accounted for.
   *
   * **ONE CASE OVER ALL EIGHT, because a list that refuses seven is a list with
   * one way out of it.**
   *
   * RED WHEN: any one of the eight returns instead of throwing. Watched, per
   * method.
   */
  it('REFUSES every method that would move a record on or off this device', async () => {
    const d = aDevice();
    d.provider.setContractAddress(A_CONTRACT);
    const p: any = d.provider;

    /*
     * **THE METHOD HAS TO EXIST AND THE REFUSAL HAS TO SAY WHY, AND BOTH HALVES
     * ARE HERE BECAUSE THE FIRST VERSION OF THIS CASE HAD NEITHER.** It wrapped
     * each call in a `catch` that discarded what it caught, so a method that had
     * been renamed, deleted or left undefined read exactly like one that
     * refused - measured, by misspelling one of the eight and watching this case
     * stay green. A refusal nobody can distinguish from an absence is not a
     * refusal, and what this file claims about these eight is that whoever
     * reaches one is TOLD why rather than handed a record.
     */
    const outcomes = await Promise.all(
      ['exportPrivateStates', 'importPrivateStates', 'exportSigningKeys', 'importSigningKeys',
        'setSigningKey', 'getSigningKey', 'removeSigningKey', 'clearSigningKeys']
        .map(async (name) => {
          if (typeof p[name] !== 'function') return `${name}: NOT THERE AT ALL`;
          try { await p[name](); return `${name}: ANSWERED`; } catch (e: any) {
            const said = String(e?.message ?? e);
            return /is not something this device can do/.test(said)
              ? `${name}: refused, saying why`
              : `${name}: failed without saying why - ${said}`;
          }
        }),
    );

    expect(outcomes).toEqual([
      'exportPrivateStates: refused, saying why', 'importPrivateStates: refused, saying why',
      'exportSigningKeys: refused, saying why', 'importSigningKeys: refused, saying why',
      'setSigningKey: refused, saying why', 'getSigningKey: refused, saying why',
      'removeSigningKey: refused, saying why', 'clearSigningKeys: refused, saying why',
    ]);
  });

  /**
   * **AND THE MATERIAL GOES WHEN THE SESSION DOES.**
   *
   * Locking a company, or signing out, has to end this device's ability to act
   * on it - otherwise "held in memory for a session" is a sentence about
   * nothing.
   *
   * RED WHEN: releasing keeps the entry - the record is still composed after
   * the company is locked. Watched.
   */
  it('stops composing anything once the material is released', async () => {
    const d = aDevice();
    d.provider.setContractAddress(A_CONTRACT);
    expect(await d.provider.get(ID)).not.toBeNull();

    d.memory.releaseAll();
    expect(await d.provider.get(ID)).toBeNull();
  });
});
