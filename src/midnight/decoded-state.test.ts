/**
 * **A SERVED STATE IS DECODED BY THE CALLER'S OWN RUNTIME, AND ONLY A STATE OF THE LEDGER ERA THIS BUILD READS.**
 *
 * The states are real ones: an empty contract state made by the contract runtime, by ledger 9 and by ledger 8,
 * wrapped as the indexer's reader serves a state, with the era of the ledger that wrote it.
 */
import { describe, expect, it, vi } from 'vitest';
import { ContractState as RuntimeState } from '@midnight-ntwrk/compact-runtime';
import { ContractState as LedgerState } from '@midnightntwrk/ledger-v9';
import { ContractState as EarlierLedgerState } from '@midnightntwrk/ledger-v8';
import { SerializedContractState } from '@midnight-ntwrk/midnight-js-types';
import { decodedState } from './decoded-state.js';

describe('THE ONE DECODE OF A STATE AS THE INDEXER SERVES IT', () => {
  it('decodes a ledger 9 state with the runtime the caller names, the contract runtime or the ledger', () => {
    const served = SerializedContractState.fromBytes('v9', new LedgerState().serialize());
    const asTheRuntimeReadsIt = decodedState(served, RuntimeState);
    const asTheLedgerReadsIt = decodedState(served, LedgerState);
    /* RED WHEN: the decode hands on the served read, or decodes with one runtime whatever the caller names. */
    expect([asTheRuntimeReadsIt instanceof RuntimeState, asTheLedgerReadsIt instanceof LedgerState]).toEqual([true, true]);
  });

  it('refuses a state an earlier ledger wrote rather than reading it as this ledger\'s', () => {
    const served = SerializedContractState.fromBytes('v8', new EarlierLedgerState().serialize());
    const readsAnything = { deserialize: vi.fn(() => 'read') };
    /* RED WHEN: the decode is given a decoder for the earlier era too, so an earlier ledger's state reads as this one's. */
    expect(() => decodedState(served, readsAnything)).toThrow();
    expect(readsAnything.deserialize).not.toHaveBeenCalled();
  });
});
