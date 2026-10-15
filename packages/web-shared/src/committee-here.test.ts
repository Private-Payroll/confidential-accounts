import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { policyBarKey } from '../../../src/midnight/spending-policy.js';
import { superAdminsHere, superAdminsShown, type SuperAdminChangeInProgress, type SuperAdminsHere } from './committee-here.js';

/*
 * Who the company's super admins are, read on this device from the account's
 * maintenance authority at the indexer the person's own wallet names, and
 * which of the company's contracts do not yet hold them. The chain here is a
 * map of contract states; the runtime's reader and the account's compiled
 * reader are handed in as they are on the device, so what is read, and from
 * where, is exactly what the device reads.
 */
/** Wallet key `n`: the x-only public key of a secret made of one repeated byte, a key the chain builds a committee with. */
const walletKey = (n: number) => ({ tag: 'schnorr', value: Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex') });
const K1 = walletKey(1);
const K2 = walletKey(2);
const K3 = walletKey(3);
const ACCOUNT = 'a0'.repeat(32);
const ADOPTED = 'b1'.repeat(32);
const RETIRED = 'b2'.repeat(32);
const CREATED = 'b3'.repeat(32);
const NOWHERE = 'b4'.repeat(32);
const STRANGER = 'b5'.repeat(32);
const bytes = (hex: string) => Uint8Array.from(hex.match(/../gu)!.map((b) => parseInt(b, 16)));

type Keys = ReadonlyArray<{ tag: string; value: string }>;
interface Contract { committee: Keys; threshold: number; counter: bigint; view?: Record<string, unknown> }

/* The chain as the wallet's indexer would serve it: each contract's state, deserialized by the runtime's reader. */
const chainOf = (contracts: Record<string, Contract>) => {
  const reads: string[] = [];
  const stateOf = (address: string) => {
    const c = contracts[address]!;
    return { maintenanceAuthority: { committee: c.committee.map((k) => ({ ...k })), threshold: c.threshold, counter: c.counter }, data: c.view ?? {} };
  };
  return {
    reads,
    deps: {
      runtimeState: { deserialize: (b: Uint8Array) => stateOf(Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) },
      accountLedger: (data: unknown) => data,
    },
    chain: {
      contractState: async (address: string) => {
        reads.push(address);
        return contracts[address] === undefined ? null : { serialize: () => bytes(address) };
      },
      /* Every contract whose own state names the account: the claim a vault makes for itself, offered and never to be asked. */
      contractsClaiming: async (account: string) => {
        reads.push(`claims of ${account}`);
        return Object.keys(contracts).filter((a) => (contracts[a]!.view as { account?: string } | undefined)?.account === account);
      },
    },
  };
};

const accountView = (over: Record<string, unknown> = {}) => ({
  vaults: [bytes(ADOPTED)], retiredAt: [[bytes(RETIRED), 1n]], ...over,
});
const company = (over: Partial<Record<string, Contract>> = {}): Record<string, Contract> => ({
  [ACCOUNT]: { committee: [K1, K2], threshold: 2, counter: 3n, view: accountView() },
  [ADOPTED]: { committee: [K1, K2], threshold: 2, counter: 1n },
  [RETIRED]: { committee: [K1, K2], threshold: 2, counter: 2n },
  [CREATED]: { committee: [K1], threshold: 1, counter: 0n },
  [STRANGER]: { committee: [K3], threshold: 1, counter: 0n, view: { account: ACCOUNT } },
  ...over,
} as Record<string, Contract>);
const ask = (inProgress: SuperAdminChangeInProgress | null = null) => ({ account: ACCOUNT, createdByTheCompany: [CREATED, ADOPTED, NOWHERE], inProgress });

describe('WHO THE SUPER ADMINS ARE, READ ON THIS DEVICE FROM THE ACCOUNT ON THE CHAIN', () => {
  it('are the account\'s committee and threshold, and every contract the company made is read with its own authority', async () => {
    const c = chainOf(company());
    const got = await superAdminsHere(c.deps, c.chain, ask());
    expect(got.superAdmins).toEqual({ committee: [K1, K2], threshold: 2, counter: 3n });
    expect(got.refused).toBeNull();
    /* RED WHEN: a vault the account adopted, one it retired, or one the company's own records say it created is left out. */
    expect(got.contracts.map((x) => [x.contract, x.address, x.foundBy, x.current])).toEqual([
      ['account', ACCOUNT, [], true],
      ['vault', ADOPTED, ['adopted', 'created by the company'], true],
      ['vault', RETIRED, ['retired'], true],
      ['vault', CREATED, ['created by the company'], false],
      ['vault', NOWHERE, ['created by the company'], false],
    ]);
    expect(got.contracts[3]!.authority).toEqual({ committee: [K1], threshold: 1, counter: 0n });
    expect(got.contracts[4]!.why).toMatch(/holds no contract at this address/);
    /* RED WHEN: a contract holding another committee than the account's is not named as behind: a half-changed company goes unseen. */
    expect(got.behind).toEqual([CREATED, NOWHERE]);
    /* RED WHEN: a contract is found by anything but the account's lists and the company's records, such as a vault's own claim. */
    expect(c.reads).not.toContain(STRANGER);
    expect(c.reads).not.toContain(`claims of ${ACCOUNT}`);
  });

  it('A SIGNER\'S CHANGE, A VAULT\'S BAR OR A BAND NEVER MOVES THE SUPER ADMINS OR WHICH CONTRACTS ARE BEHIND', async () => {
    const before: SuperAdminsHere = await (async () => { const c = chainOf(company()); return superAdminsHere(c.deps, c.chain, ask()); })();
    /* Two more signers seated, a vault's threshold of three, a band and a policy bar of four, the signers' threshold at three. */
    const moved = chainOf(company({
      [ACCOUNT]: {
        committee: [K1, K2], threshold: 2, counter: 3n,
        view: accountView({
          signerLeaves: [bytes('c1'.repeat(32)), bytes('c2'.repeat(32)), bytes('c3'.repeat(32)), bytes('c4'.repeat(32))],
          /* The account's own fields: its threshold, each vault's bar and the policy bar under its key in `thresholds`, and a band in the shared map. */
          threshold: 3n, thresholds: [[bytes(ADOPTED), 3n], [bytes(policyBarKey()), 4n]], signerRoles: [[bytes('d1'.repeat(32)), bytes('04'.repeat(32))]],
        }),
      },
    }));
    const after = await superAdminsHere(moved.deps, moved.chain, ask());
    /* RED WHEN: a signer's change, a vault bar or a band moves the super admins, their threshold, or which contracts are behind. */
    expect(after.superAdmins).toEqual(before.superAdmins);
    expect(after.behind).toEqual(before.behind);
    expect(after.contracts).toEqual(before.contracts);
  });

  it('while the super admins change, a contract is current only when it holds that change\'s committee', async () => {
    const change: SuperAdminChangeInProgress = {
      committee: [K1, K2, K3], threshold: 2,
      contracts: [{ address: ACCOUNT, counter: 3n }, { address: ADOPTED, counter: 1n }],
    };
    const c = chainOf(company({ [ADOPTED]: { committee: [K1, K2, K3], threshold: 2, counter: 2n } }));
    const got = await superAdminsHere(c.deps, c.chain, ask(change));
    /* RED WHEN: any contract is judged against anything but the change in progress while one is. */
    expect(got.contracts.filter((x) => x.current).map((x) => x.address)).toEqual([ADOPTED]);
    expect(got.behind).toEqual([ACCOUNT, RETIRED, CREATED, NOWHERE]);
    /* The super admins are still who the account holds until its own update lands. */
    expect(got.superAdmins.committee).toEqual([K1, K2]);
  });

  it('A CONTRACT HOLDING THE RIGHT KEYS AT ANOTHER THRESHOLD IS BEHIND, WHETHER OR NOT THE SUPER ADMINS ARE CHANGING', async () => {
    const c = chainOf(company({ [ADOPTED]: { committee: [K1, K2], threshold: 1, counter: 1n } }));
    /* RED WHEN: a vault is judged current on its keys alone, while the account requires two of them and it one. */
    expect((await superAdminsHere(c.deps, c.chain, ask())).behind).toContain(ADOPTED);
    const change: SuperAdminChangeInProgress = { committee: [K1, K2, K3], threshold: 2, contracts: [] };
    const during = chainOf(company({ [ADOPTED]: { committee: [K1, K2, K3], threshold: 3, counter: 2n } }));
    /* RED WHEN: during a change, a contract holding its keys at another threshold than it installs is judged current. */
    expect((await superAdminsHere(during.deps, during.chain, ask(change))).behind).toContain(ADOPTED);
    /* A change naming its keys in capitals is the same committee as the chain's lower-case keys. */
    const shouted: SuperAdminChangeInProgress = { ...change, threshold: 3, committee: change.committee.map((k) => ({ ...k, value: k.value.toUpperCase() })) };
    expect((await superAdminsHere(during.deps, during.chain, ask(shouted))).behind).not.toContain(ADOPTED);
  });

  it('names an account held by a committee the one install rule refuses', async () => {
    for (const [committee, threshold, why] of [
      [[K1, K1], 2, /are the same key/], [[K1, K2], 0, /not a whole number of at least one/], [[K1, K2], 3, /can never be met/],
    ] as const) {
      const c = chainOf(company({ [ACCOUNT]: { committee, threshold, counter: 3n, view: accountView() } }));
      /* RED WHEN: a world-writable or unchangeable account, or one whose threshold counts a key twice, is not named. */
      expect((await superAdminsHere(c.deps, c.chain, ask())).refused).toMatch(why);
    }
  });

  it('believes nothing about the super admins when the account cannot be read at the wallet\'s indexer', async () => {
    const absent = chainOf({});
    /* RED WHEN: the super admins are named from anything but the account's state on the chain. */
    await expect(superAdminsHere(absent.deps, absent.chain, ask())).rejects.toThrow(/does not hold the company's account yet/);
    const unreadable = chainOf(company({ [ACCOUNT]: { committee: [{ tag: 'schnorr', value: 'zz' }], threshold: 1, counter: 3n, view: accountView() } }));
    await expect(superAdminsHere(unreadable.deps, unreadable.chain, ask())).rejects.toThrow(/super admins are not known/);
    const noLists = chainOf(company({ [ACCOUNT]: { committee: [K1], threshold: 1, counter: 3n, view: {} } }));
    await expect(superAdminsHere(noLists.deps, noLists.chain, ask())).rejects.toThrow(/does not list the vaults it adopted and retired/);
  });
});

describe('EVERY SUPER ADMIN SHOWN BY THE KEY THE CHAIN HOLDS, WITH A SEAT ONLY WHERE A BELIEVED SEAT PROVES IT', () => {
  const SEAT_1 = 'c1'.repeat(32);
  const SEAT_3 = 'c3'.repeat(32);
  /* What a member's device believes of each seat: the wallet key its entry's opening proved, for display beside a key. */
  const seats = [
    { seat: SEAT_1, person: 'ada', committeeKey: { ...K1 } },
    { seat: SEAT_3, person: 'cy', committeeKey: { ...K3 } },
  ];

  it('a device whose own wallet key is on the committee reads itself a super admin, with no seat at all', async () => {
    const c = chainOf(company());
    const { superAdmins } = await superAdminsHere(c.deps, c.chain, ask());
    /* RED WHEN: a device decides it is a super admin from a seat, a stored role or anything but its own key on the chain's committee. */
    const mine = superAdminsShown(superAdmins, [], { ...K2, value: K2.value.toUpperCase() });
    expect(mine.iAmOne).toBe(true);
    expect(mine.shown).toEqual([{ key: K1, seat: null, mine: false }, { key: K2, seat: null, mine: true }]);
    /* A seat this device believes, whose key is not on the committee, makes nobody a super admin. */
    expect(superAdminsShown(superAdmins, seats, K3).iAmOne).toBe(false);
    expect(superAdminsShown(superAdmins, seats, null).iAmOne).toBe(false);
  });

  it('a committee key no seat proves is listed as a super admin by its key and flagged for nothing; one a believed seat proves carries that seat', async () => {
    const c = chainOf(company());
    const { superAdmins } = await superAdminsHere(c.deps, c.chain, ask());
    const got = superAdminsShown(superAdmins, seats, null);
    /* RED WHEN: a committee key no seat proves is left out, marked for removal, or shown as anything but a full super admin. */
    expect(got.shown).toEqual([
      { key: K1, seat: { seat: SEAT_1, person: 'ada' }, mine: false },
      { key: K2, seat: null, mine: false },
    ]);
    /* RED WHEN: a seat whose key the chain's committee does not hold is listed among the super admins. */
    expect(got.shown.map((x) => x.key.value)).not.toContain(K3.value);
  });
});
