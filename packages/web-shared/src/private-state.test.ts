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
  derivedPrivateState, signerHalfOf, SignerMaterialHeldInMemory,
  type AccountHalfStore, type SignerMaterial, type StorableHalf,
} from './private-state.js';
import { fromHex, toHex } from '../../../src/core/crypto.js';

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

const A_CONTRACT = 'aa'.padEnd(64, '0');
const ANOTHER_CONTRACT = 'bb'.padEnd(64, '0');
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
    const v = d.provider.forContract(A_CONTRACT);

    const record = (await v.get(ID))!;
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
    const v = d.provider.forContract(A_CONTRACT);

    const record = (await v.get(ID))!;
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
    const v = d.provider.forContract(A_CONTRACT);
    expect(await v.get(ID)).toBeNull();
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
    const v = d.provider.forContract(A_CONTRACT);

    const record = (await v.get(ID))!;
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
    const v = d.provider.forContract(A_CONTRACT);

    await v.set(ID, {
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
    const v = d.provider.forContract(A_CONTRACT);

    await expect(v.set(ID, {
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
    const v = d.provider.forContract(A_CONTRACT);
    await v.set(ID, { assetId: new Uint8Array([7]) } as never);

    expect(d.writes.map((w) => [w.address, w.id, [...(w.half.assetId ?? [])].join()]))
      .toEqual([[A_CONTRACT, ID, '7']]);
  });
});

describe('which company a read is about', () => {
  /**
   * **THE ADDRESS IS PASSED DOWN AND NOT REMEMBERED UNDERNEATH.**
   *
   * Each company is reached through its own view. A store that kept its own
   * copy of an address would answer from whichever contract was addressed
   * last, which is another company's record under this company's name.
   *
   * RED WHEN: the address stops being handed to the store, or one view answers
   * under another's address - both reads then name the same one. Watched.
   */
  it('asks the store under the address the view was opened for, each time', async () => {
    const d = aDevice();
    const one = d.provider.forContract(A_CONTRACT);
    const other = d.provider.forContract(ANOTHER_CONTRACT);
    await one.get(ID);
    await other.get(ID);
    await one.get(ID);

    expect(d.reads.map((r) => r.address)).toEqual([A_CONTRACT, ANOTHER_CONTRACT, A_CONTRACT]);
  });

  /**
   * **ONE COMPANY HAS ONE ADDRESS, HOWEVER IT IS WRITTEN.** The scheme compares
   * addresses in lower case, so a store keyed on the case it was handed would
   * keep one company's record under two names, and a read under one would miss
   * a write under the other.
   *
   * RED WHEN: the view keeps the address in the case it was given. Watched.
   */
  /* RED WHEN: a view is opened for an empty or malformed address, so a company's private state is kept under no company. */
  it('opens no view for something that is not a contract address', () => {
    const d = aDevice();
    expect(() => d.provider.forContract('')).toThrow(/is not a contract address/);
    expect(() => d.provider.forContract(`0200${A_CONTRACT}`)).toThrow(/is not a contract address/);
  });

  it('names the store\'s entry in lower case, whatever case the address arrived in', async () => {
    const d = aDevice();
    const view = d.provider.forContract(A_CONTRACT.toUpperCase());
    await view.set(ID, { assetId: new Uint8Array([7]) } as never);

    expect([view.contractAddress, d.writes[0]!.address]).toEqual([A_CONTRACT, A_CONTRACT]);
  });

  /**
   * **AND THERE IS NO SETTER LEFT FOR A CALLER TO REACH.** An address held in
   * a field is one a call can inherit from whichever call set it last.
   *
   * RED WHEN: the provider offers a contract-address setter again. Watched.
   */
  it('offers no way to set a contract address outside a view', () => {
    const d = aDevice();
    expect('setContractAddress' in d.provider).toBe(false);
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
   * The six maintenance-authority methods are refused for a different reason
   * and the message says which: that authority is not something a browser holds
   * here, so a device keeping one would be a durable place for key material
   * that nothing in this design has accounted for. Clearing every company at
   * once is refused because nothing here reaches across companies.
   *
   * **ONE CASE OVER ALL NINE, because a list that refuses eight is a list with
   * one way out of it.**
   *
   * RED WHEN: any one of the nine returns instead of throwing, or clearing every
   * company reaches the store. Watched, per method.
   */
  it('REFUSES every method that would move a record on or off this device', async () => {
    const d = aDevice();
    const p: any = d.provider;
    const view: any = d.provider.forContract(A_CONTRACT);

    /*
     * **THE METHOD HAS TO EXIST AND THE REFUSAL HAS TO SAY WHY.** A case that
     * discarded what each call threw would read a method that had been renamed,
     * deleted or left undefined exactly like one that refused. A refusal nobody
     * can distinguish from an absence is not a refusal, and what this file
     * claims about these nine is that whoever reaches one is TOLD why rather
     * than handed a record.
     */
    const outcomes = await Promise.all(
      [['exportPrivateStates', view], ['importPrivateStates', view], ['exportSigningKeys', p], ['importSigningKeys', p],
        ['setSigningKey', p], ['getSigningKey', p], ['removeSigningKey', p], ['clearSigningKeys', p], ['clearAll', p]]
        .map(async ([name, on]) => {
          if (typeof on[name] !== 'function') return `${name}: NOT THERE AT ALL`;
          try { await on[name](); return `${name}: ANSWERED`; } catch (e: any) {
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
      'clearAll: refused, saying why',
    ]);
    expect(d.cleared, 'clearing every company reached the store').toEqual([]);
  });

  /**
   * **AND THE MATERIAL GOES WHEN THE PERSON SIGNS OUT.**
   *
   * Locking a company, or signing out, has to end this device's ability to act
   * on it - otherwise "held in memory while signed in" is a sentence about
   * nothing.
   *
   * RED WHEN: releasing keeps the entry - the record is still composed after
   * the company is locked. Watched.
   */
  it('stops composing anything once the material is released', async () => {
    const d = aDevice();
    const v = d.provider.forContract(A_CONTRACT);
    expect(await v.get(ID)).not.toBeNull();

    d.memory.releaseAll();
    expect(await v.get(ID)).toBeNull();
  });
});

describe('the rights a seat was given reach every run it proves', () => {
  it('a seat\'s rights record is handed to the circuit, and one its scope does not commit to is refused', async () => {
    const { rightsOfRole, rightsScopeOf } = await import('../../../src/core/seat-rights.js');
    const { signerMaterialOf } = await import('./private-state.js');
    const record = rightsOfRole('approver', ['9a'.repeat(32) as never]);
    const seat = { signingSecret: ADA.signingSecret, blinding: ADA.blinding, scope: rightsScopeOf(record), rights: record };
    /* RED WHEN: a seat seated with its role's rights proves runs with no record, and every approval it gives fails inside the proof. */
    const half = signerHalfOf(signerMaterialOf(seat));
    expect(half.rights).toMatchObject({ mayRaise: false, mayApprove: true, mayHold: true, everyVault: false });
    expect(toHex(half.rights!.vaults[0]!)).toBe('9a'.repeat(32));
    /* RED WHEN: a record the seat's leaf does not commit to is proved with, and the seat seems to hold rights it does not. */
    expect(() => signerHalfOf(signerMaterialOf({ ...seat, rights: rightsOfRole('admin', ['9a'.repeat(32) as never]) })))
      .toThrow(/not the ones this seat's leaf commits to/u);
    /* A seat on every vault holds no record. */
    expect(signerHalfOf(ADA).rights).toBeNull();
  });

  it('the rights record is never written to storage beside the account half', async () => {
    const { neverPersistedFieldsIn } = await import('../../../src/midnight/what-a-device-may-persist.js');
    /* RED WHEN: a seat's rights are kept a second time outside its saved keys. */
    expect(neverPersistedFieldsIn({ rights: null })).toEqual(['rights']);
  });
});
