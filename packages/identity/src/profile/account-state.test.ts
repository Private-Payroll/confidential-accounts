import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractMaintenanceAuthority, ContractState, StateMap, StateValue } from '@midnightntwrk/ledger-v9';

vi.mock('./contract-authority.js', async (original) => {
  const real = await original<typeof import('./contract-authority.js')>();
  return { ...real, authorityIn: vi.fn(real.authorityIn) };
});

const { authorityIn } = await import('./contract-authority.js');
const { authorityIn: realAuthorityIn } = await vi.importActual<typeof import('./contract-authority.js')>('./contract-authority.js');
const { SIGNER_LEAVES_FIELD, seatsInAccountState } = await import('./account-state.js');

/*
 * Who holds an account is read off its serialised state: the seats from the
 * account's own set of seated signers, the committee and threshold from the
 * contract's authority.
 */
const KEY_A = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const KEY_B = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const LEAF = 'ab'.repeat(32);
const bytes32 = { value: [], alignment: [{ tag: 'atom', value: { tag: 'bytes', length: 32 } }] };

/** A state laid out as far as the seats need: one seated signer, and the given authority. */
const accountHeldBy = (committee: string[], threshold: number): Uint8Array => {
  const leaf = { ...bytes32, value: [Uint8Array.from(LEAF.match(/../gu)!.map((h) => parseInt(h, 16)))] };
  let fields = StateValue.newArray();
  for (let i = 0; i < SIGNER_LEAVES_FIELD; i += 1) fields = fields.arrayPush(StateValue.newNull());
  fields = fields.arrayPush(StateValue.newMap(new StateMap().insert(leaf as never, StateValue.newNull())));
  const state = new ContractState();
  state.data = new (Object.getPrototypeOf(state.data).constructor)(fields);
  state.maintenanceAuthority = new ContractMaintenanceAuthority(committee.map((value) => ({ tag: 'schnorr', value })) as never, threshold, 0n);
  return state.serialize();
};

describe('who holds an account, from its serialised state', () => {
  /* A value queued for one test never reaches the next: the reader goes back to the real one. */
  afterEach(() => {
    vi.mocked(authorityIn).mockReset();
    vi.mocked(authorityIn).mockImplementation(realAuthorityIn);
  });

  it('lists the seats, the committee and the threshold', () => {
    /* RED WHEN: the committee, the threshold or the seats are dropped or changed on the way out. */
    expect(seatsInAccountState(accountHeldBy([KEY_A, KEY_B], 2))).toEqual({
      committee: [{ tag: 'schnorr', value: KEY_A }, { tag: 'schnorr', value: KEY_B }], threshold: 2, seats: [LEAF],
    });
  });

  it('reads the committee and the threshold through the one reader of a contract\'s authority', () => {
    const asked = vi.mocked(authorityIn);
    asked.mockClear();
    seatsInAccountState(accountHeldBy([KEY_A], 1));
    /* RED WHEN: the account reads the contract's authority by its own means, so there are two readings of who holds a contract. */
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('returns the committee and the threshold the reader gave, not the ones the state holds', () => {
    const given = { committee: [{ tag: 'schnorr', value: KEY_B }], threshold: 5, counter: 0n };
    vi.mocked(authorityIn).mockReturnValueOnce(given);
    const held = seatsInAccountState(accountHeldBy([KEY_A], 1));
    /* RED WHEN: the account reads the authority off the state itself while still calling `authorityIn`. */
    expect(held.committee).toEqual(given.committee);
    expect(held.threshold).toBe(5);
  });

  it('refuses a state whose authority cannot be read, saying what was missing', () => {
    vi.mocked(authorityIn).mockReturnValueOnce({ why: 'the contract\'s threshold is not a whole number of at least zero.' });
    /* RED WHEN: an authority the reader refused is read anyway, or is refused without saying why. */
    expect(() => seatsInAccountState(accountHeldBy([KEY_A], 1)))
      .toThrow(/not laid out as a company's account: the contract's threshold is not a whole number/u);
  });

  it('refuses bytes that are not laid out as an account', () => {
    const state = new ContractState();
    /* RED WHEN: a contract with no seated signers is read as an account with none. */
    expect(() => seatsInAccountState(state.serialize())).toThrow(/not laid out as a company's account/u);
  });
});
