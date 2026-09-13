import { describe, it, expect } from 'vitest';
import { StateValue, ChargedState } from '@midnight-ntwrk/compact-runtime';

import {
  compareLedgerShape, assertLedgerShapesAgree, shapeOfDeployedState,
  compiledVaultLedgerShape, assertVaultLedgerIsThisBuilds, VaultLedgerShapeMismatch,
  type LedgerShape,
} from './vault-ledger-shape.js';

/**
 * **THREE VAULTS DEPLOYED FROM THREE BUILDS, REBUILT HERE WITHOUT A NETWORK.**
 *
 * The shapes below were read off the live chain on 13 Sep, through this build's
 * own reader, and every state this file compares is assembled out of the slots
 * this build's OWN contract constructor produces - so a control that fails
 * because the contract changed is a control that has noticed the contract
 * changed, which is its job.
 *
 *   the contract this build compiled   5 slots   cell,map,map,cell,map
 *   a vault deployed 28 Aug            3 slots   cell,map,cell
 *   a vault deployed 29 Aug            4 slots   cell,map,map,cell
 *   a vault deployed  9 Sep            5 slots   cell,map,map,cell,map
 */
const MEASURED_ON_CHAIN = {
  deployedAug28: ['cell', 'map', 'cell'],
  deployedAug29: ['cell', 'map', 'map', 'cell'],
  deployedSep9: ['cell', 'map', 'map', 'cell', 'map'],
} as const;

/** Which of this build's slots each of those vaults actually carries, by position. */
const SLOTS_OF = {
  deployedAug28: [0, 1, 3],
  deployedAug29: [0, 1, 2, 3],
  deployedSep9: [0, 1, 2, 3, 4],
} as const;

const shape = (...slots: string[]): LedgerShape => ({ slots });

/* ------------------------------------------------------------------ *
 * §1 THE COMPARISON, PURE
 * ------------------------------------------------------------------ */

describe('§1 two shapes, compared, with nothing else in the room', () => {
  const FIVE = shape('cell', 'map', 'map', 'cell', 'map');
  const NAMES = ['account', 'notes', 'unshieldedTokens', 'payments', 'spendingCaps'];

  it('matches a vault of the same length whose every slot is stored the same way', () => {
    /* RED WHEN the comparison refuses a vault it should accept, which stops every payment. */
    expect(compareLedgerShape(FIVE, shape('cell', 'map', 'map', 'cell', 'map'), NAMES))
      .toEqual({ of: 'matches' });
  });

  it('refuses a vault with fewer fields, and names the ones it does not have', () => {
    const verdict = compareLedgerShape(FIVE, shape(...MEASURED_ON_CHAIN.deployedAug29), NAMES);
    /* RED WHEN a shorter ledger is accepted. */
    expect(verdict.of).toBe('differs');
    /* RED WHEN the refusal does not say how many each side has. */
    expect(verdict.of === 'differs' && verdict.why).toContain('holds 4 ledger fields');
    expect(verdict.of === 'differs' && verdict.why).toContain('compiled has 5');
    /* RED WHEN the missing field is not named, which is the only actionable part. */
    expect(verdict.of === 'differs' && verdict.why).toContain('spendingCaps');
  });

  it('names every missing field when more than one is missing, in order', () => {
    const verdict = compareLedgerShape(FIVE, shape(...MEASURED_ON_CHAIN.deployedAug28), NAMES);
    /* RED WHEN only the first missing field is named. */
    expect(verdict.of === 'differs' && verdict.why).toContain('payments, spendingCaps');
  });

  it('refuses a vault with MORE fields than this build has, and says so differently', () => {
    const verdict = compareLedgerShape(FIVE, shape('cell', 'map', 'map', 'cell', 'map', 'map'), NAMES);
    /* RED WHEN a longer ledger is accepted because only "at least this many" was checked. */
    expect(verdict.of).toBe('differs');
    /* RED WHEN a longer ledger is described as missing fields, which would send somebody looking for the wrong thing. */
    expect(verdict.of === 'differs' && verdict.why).toContain('more of them');
    expect(verdict.of === 'differs' && verdict.why).not.toContain('missing');
  });

  it('refuses a vault of the right length whose slot is stored differently, naming that field', () => {
    const verdict = compareLedgerShape(FIVE, shape('cell', 'map', 'map', 'map', 'cell'), NAMES);
    /* RED WHEN only the count is compared. */
    expect(verdict.of).toBe('differs');
    /* RED WHEN the FIRST disagreement is not the one reported. */
    expect(verdict.of === 'differs' && verdict.why).toContain('"payments"');
    expect(verdict.of === 'differs' && verdict.why).toContain('"map"');
    expect(verdict.of === 'differs' && verdict.why).toContain('"cell"');
  });

  it('gives a field with no name a position rather than the word undefined', () => {
    const verdict = compareLedgerShape(shape('cell', 'map'), shape('cell', 'cell'), ['account']);
    /* RED WHEN a contract that grew a field this build has no name for produces "undefined" on screen. */
    expect(verdict.of === 'differs' && verdict.why).toContain('field 2');
    expect(verdict.of === 'differs' && verdict.why).not.toContain('undefined');
  });

  it('CANNOT tell two same-storage fields apart when they are swapped, and this pins that limit', () => {
    /*
     * The two `map` fields at positions 2 and 5 - `notes` and `spendingCaps` -
     * swapped with each other. **The comparison says they match, and it is
     * right to**: the chain holds no field names, so two maps in the other
     * order are the same bytes in the same places and no client can tell.
     *
     * RED WHEN somebody makes this refuse, which would mean the comparison had
     * started claiming something the chain cannot tell it. The limit is stated
     * in the module and pinned here so that it is a decision and not an
     * oversight - and so that the day it becomes detectable, this is where the
     * claim gets corrected.
     */
    const swapped = [FIVE.slots[4]!, FIVE.slots[1]!];
    const permuted = shape(FIVE.slots[0]!, swapped[0], FIVE.slots[2]!, FIVE.slots[3]!, swapped[1]);
    expect(permuted.slots).not.toEqual(['cell', 'map', 'map', 'cell', 'map'].map((x, i) => (i === 1 ? 'SWAPPED' : x)));
    expect(compareLedgerShape(FIVE, permuted, NAMES)).toEqual({ of: 'matches' });
    /* And the swap really is a swap of two DIFFERENT fields of the same storage. */
    expect(NAMES[1]).not.toBe(NAMES[4]);
    expect(FIVE.slots[1]).toBe(FIVE.slots[4]);
  });

  it('the refusal names what resolves it and says nothing was spent', () => {
    let thrown: unknown;
    try { assertLedgerShapesAgree(FIVE, shape(...MEASURED_ON_CHAIN.deployedAug29), NAMES); }
    catch (e) { thrown = e; }
    /* RED WHEN the assertion does not throw on a shape that differs. */
    expect(thrown).toBeInstanceOf(VaultLedgerShapeMismatch);
    const why = (thrown as Error).message;
    /* RED WHEN a refusal on the money path does not say whether money moved. */
    expect(why).toContain('Nothing was proved, submitted or spent.');
    /* RED WHEN the refusal names no way out (a refusal has to name what resolves it). */
    expect(why).toContain('Deploy a vault from this build');
    /* RED WHEN it suggests the vault can be repaired, which it cannot. */
    expect(why).toContain('fixed when it is deployed');
    /* RED WHEN both shapes are not carried for a caller to report. */
    expect((thrown as VaultLedgerShapeMismatch).compiled.slots).toHaveLength(5);
    expect((thrown as VaultLedgerShapeMismatch).deployed.slots).toHaveLength(4);
  });

  it('does not throw when the shapes agree', () => {
    /* RED WHEN the assertion throws on a match, which refuses every vault. */
    expect(() => assertLedgerShapesAgree(FIVE, shape('cell', 'map', 'map', 'cell', 'map'), NAMES))
      .not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * §2 THE READERS, AGAINST STATES THIS BUILD'S OWN CONTRACT MADE
 * ------------------------------------------------------------------ */

/** A contract state carrying exactly the canonical slots named, in that order. */
const stateOfSlots = (canonical: readonly unknown[] | undefined, take: readonly number[]) => {
  if (!canonical) throw new Error('the control was handed no slots to build a state from');
  let array = StateValue.newArray();
  for (const at of take) array = array.arrayPush(canonical[at] as never);
  return { data: new ChargedState(array) };
};

describe('§2 the shape of a state, read off the state', () => {
  it('this build\x27s contract states its own shape, and it is the 9 Sep vault\x27s', async () => {
    const { shape: compiled, fields } = await compiledVaultLedgerShape();
    /* RED WHEN the canonical shape is transcribed from a table instead of produced by the contract. */
    expect(compiled.slots).toEqual([...MEASURED_ON_CHAIN.deployedSep9]);
    /* RED WHEN the field names are not read off the contract, in declaration order. */
    expect(fields).toEqual(['account', 'notes', 'unshieldedTokens', 'payments', 'spendingCaps']);
  });

  it('reads back the three shapes measured on chain, from states built out of those same slots', async () => {
    const { shape: compiled } = await compiledVaultLedgerShape();
    const canonical = (await realCanonicalState()).state.asArray();
    for (const name of ['deployedAug28', 'deployedAug29', 'deployedSep9'] as const) {
      /* RED WHEN the reader does not report a deployed state's own slot kinds in order. */
      expect(shapeOfDeployedState(stateOfSlots(canonical, SLOTS_OF[name])).slots, name)
        .toEqual([...MEASURED_ON_CHAIN[name]]);
    }
    expect(compiled.slots).toEqual([...MEASURED_ON_CHAIN.deployedSep9]);
  });

  it('THE COMPILED READER\x27S FIELD NAMES ARE NOT EVIDENCE, and that is why this exists', async () => {
    const { ledger } = await import('../../contracts/managed-vault/contract/index.js');
    const canonical = (await realCanonicalState()).state.asArray();
    const threeFields = stateOfSlots(canonical, SLOTS_OF.deployedAug28);
    /*
     * RED WHEN the reader stops answering with all five names on a three-field
     * vault. That would mean a name-based check had become possible, and the
     * argument for this whole module would have changed.
     */
    expect(Object.keys((ledger as (d: unknown) => object)(threeFields.data)))
      .toEqual(['account', 'notes', 'unshieldedTokens', 'payments', 'spendingCaps']);
    /* RED WHEN a field past the end of a short ledger stops throwing, silently answering instead. */
    expect(() => (ledger as (d: unknown) => { payments: unknown })(threeFields.data).payments)
      .toThrow(/index out of bounds/);
  });

  it('refuses a state whose top level is not an array of fields', async () => {
    const notAnArray = { data: new ChargedState(StateValue.newNull()) };
    /* RED WHEN a state that is not a ledger is read as an empty one. */
    expect(() => shapeOfDeployedState(notAnArray)).toThrow(VaultLedgerShapeMismatch);
    expect(() => shapeOfDeployedState(notAnArray)).toThrow('where a contract\x27s ledger is an array');
  });

  it('refuses a state that carries nothing openable at all, and does not call it empty', () => {
    for (const nothing of [undefined, null, {}, { data: {} }, { data: { state: {} } }]) {
      /* RED WHEN an unreadable state is treated as a vault holding nothing. */
      expect(() => shapeOfDeployedState(nothing), String(nothing)).toThrow(VaultLedgerShapeMismatch);
    }
    expect(() => shapeOfDeployedState({})).toThrow('That is not an empty vault');
  });
});

/* ------------------------------------------------------------------ *
 * §3 THE GATE
 * ------------------------------------------------------------------ */

describe('§3 the gate every deposit and every payout passes through', () => {
  it('lets a vault of this build\x27s own shape through', async () => {
    const canonical = await realCanonicalState();
    /* RED WHEN the gate refuses the vault this build deploys, which refuses every payment. */
    await expect(assertVaultLedgerIsThisBuilds({ data: new ChargedState(canonical.state) }))
      .resolves.toBeUndefined();
  });

  it('refuses the 29 Aug vault\x27s shape, which the verifier-key check passes', async () => {
    const canonical = (await realCanonicalState()).state.asArray();
    /* RED WHEN the gate lets a vault a field short through, which is the whole defect. */
    await expect(assertVaultLedgerIsThisBuilds(stateOfSlots(canonical, SLOTS_OF.deployedAug29)))
      .rejects.toThrow(VaultLedgerShapeMismatch);
  });

  it('refuses the 28 Aug vault\x27s shape', async () => {
    const canonical = (await realCanonicalState()).state.asArray();
    /* RED WHEN a two-fields-short vault is let through. */
    await expect(assertVaultLedgerIsThisBuilds(stateOfSlots(canonical, SLOTS_OF.deployedAug28)))
      .rejects.toThrow('holds 3 ledger fields');
  });
});

/**
 * The state this build's own contract constructor makes, read once.
 *
 * It runs no circuit, touches no network and starts no proof server: the
 * witnesses it is handed throw if anything calls one, and nothing does.
 */
let canonicalOnce: Promise<ChargedState> | null = null;
function realCanonicalState(): Promise<ChargedState> {
  canonicalOnce ??= (async () => {
    const { Contract } = await import('../../contracts/managed-vault/contract/index.js');
    const nothingCallsThese = new Proxy({}, {
      get: () => () => { throw new Error('the control runs no circuit'); },
    });
    const built = await new (Contract as new (w: unknown) => {
      initialState(c: unknown, a: { bytes: Uint8Array }): Promise<{
        currentContractState: { data: ChargedState };
      }>;
    })(nothingCallsThese).initialState(
      { initialPrivateState: {}, initialZswapLocalState: { coinPublicKey: new Uint8Array(32) } },
      { bytes: new Uint8Array(32) });
    return built.currentContractState.data;
  })();
  return canonicalOnce;
}
