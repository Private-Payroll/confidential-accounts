/**
 * THE PRIVATE REGISTRY, OFFLINE: EACH TAG HOLDS ONE ENTRY, WRITTEN ONCE.
 *
 * The compiled contract runs here with its own asserts; what each call leaves is read
 * from the ledger the chain would hold. A person finds their companies again from
 * these entries, so an entry that could be overwritten or written at the zero tag
 * would let anyone hide or replace another person's way back.
 *
 * Every assertion names the change that turns it red.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../managed-registry/contract/index.js';

const BLOCK = '0'.repeat(64);
const tag = (n: number) => new Uint8Array(32).fill(n);
const entry = (n: number) => new Uint8Array(288).fill(n);

class Registry {
  contract = new Contract({});
  address = String(sampleContractAddress());
  state: any;

  static async deployed(): Promise<Registry> {
    const r = new Registry();
    r.state = (await r.contract.initialState(createConstructorContext({}, BLOCK))).currentContractState;
    return r;
  }

  get entries() {
    return ledger(this.state.data ?? this.state).entries;
  }

  async put(at: Uint8Array, sealed: Uint8Array): Promise<void> {
    const ctx = createCircuitContext({
      circuitId: 'put' as never,
      contractAddress: this.address as never,
      coinPublicKeyOrZswapState: BLOCK,
      contractState: this.state,
      privateState: {},
      time: 1_800_000_000,
      parentBlockHash: BLOCK
    });
    const out: any = await (this.contract.impureCircuits as any).put(ctx, at, sealed);
    this.state = out.context.callContext.currentQueryContext.state;
  }
}

describe('THE PRIVATE REGISTRY KEEPS EACH ENTRY ONCE, AT ITS OWN TAG', () => {
  it('starts empty and keeps an entry written at a new tag', async () => {
    const r = await Registry.deployed();
    /* RED WHEN: the registry starts holding an entry nobody wrote. */
    expect(r.entries.size()).toBe(0n);
    await r.put(tag(1), entry(0xa1));
    /* RED WHEN: put does not insert, or inserts the entry under another tag. */
    expect(r.entries.member(tag(1))).toBe(true);
    expect(Buffer.from(r.entries.lookup(tag(1)))).toEqual(Buffer.from(entry(0xa1)));
    expect(r.entries.size()).toBe(1n);
  });

  it('refuses an entry at the all-zero tag, the value an unset tag carries', async () => {
    const r = await Registry.deployed();
    /* RED WHEN: the check that the tag is not zero is taken out of put. */
    await expect(r.put(tag(0), entry(0xa1))).rejects.toThrow(/no entry at the all-zero tag/u);
    expect(r.entries.size()).toBe(0n);
  });

  it('refuses a second write at a tag that already holds an entry, and keeps the first', async () => {
    const r = await Registry.deployed();
    await r.put(tag(2), entry(0xa1));
    /* RED WHEN: the check that the tag is not present is taken out of put, so a later writer replaces the entry. */
    await expect(r.put(tag(2), entry(0xb2))).rejects.toThrow(/already holds an entry at this tag/u);
    expect(Buffer.from(r.entries.lookup(tag(2)))).toEqual(Buffer.from(entry(0xa1)));
  });

  it('keeps entries at two tags side by side', async () => {
    const r = await Registry.deployed();
    await r.put(tag(3), entry(0xa1));
    await r.put(tag(4), entry(0xb2));
    /* RED WHEN: a write replaces the whole map, or drops what an earlier write kept. */
    expect(r.entries.size()).toBe(2n);
    expect(Buffer.from(r.entries.lookup(tag(3)))).toEqual(Buffer.from(entry(0xa1)));
    expect(Buffer.from(r.entries.lookup(tag(4)))).toEqual(Buffer.from(entry(0xb2)));
  });
});

describe('THE COMPILED REGISTRY HAS EXACTLY THE SHAPE IT IS DEPLOYED AND PROVED AS', () => {
  const info = JSON.parse(
    readFileSync(new URL('../managed-registry/compiler/contract-info.json', import.meta.url), 'utf8')
  ) as {
    circuits: { name: string; proof: boolean }[];
    witnesses: unknown[];
    ledger: { name: string }[];
  };

  it('has one proving circuit, put, no witnesses, and one ledger field, entries', () => {
    /* RED WHEN: the registry gains or renames a circuit, reads a witness, or keeps another ledger field: it is
     * deployed with no one able to change it, so a shape nobody meant can never be repaired. */
    expect(info.circuits.map((c) => [c.name, c.proof])).toEqual([['put', true]]);
    expect(info.witnesses).toEqual([]);
    expect(info.ledger.map((f) => f.name)).toEqual(['entries']);
  });
});
