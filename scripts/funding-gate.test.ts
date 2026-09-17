import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { keysThisMachineHolds, refusalToFund } from './funding-gate.js';
import { refusalToPutMoneyIn, type FundingFacts } from '../src/wiring/vault-submission.js';
import type { Committee } from '../src/midnight/vault-committee.js';
import { readContractAuthority } from '../src/midnight/ledger.js';

/*
 * The operator tools' funding gate: who holds a vault's rules is read from the
 * chain, and the state folder says only which keys this machine keeps.
 */
const sk = (n: number) => L.signingKeyFromBip340(new Uint8Array(32).fill(n));
const vk = (n: number) => L.signatureVerifyingKey(sk(n));
const files = (by: Record<string, unknown>) => (path: string) => {
  for (const [end, body] of Object.entries(by)) if (path.endsWith(end)) return JSON.stringify(body);
  return null;
};
const derive = (k: { tag: string; value: string }) => L.signatureVerifyingKey(k as never);
const chainWith = (authority: unknown) => async () => ({ maintenanceAuthority: authority });

const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'cd'.repeat(32);

describe('THE KEYS THIS MACHINE KEEPS', () => {
  it('are the vault\'s single key and the account\'s, when the files hold one', () => {
    const held = keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, files({
      'vault-authority-payroll.json': { kind: 'single-key', signingKey: sk(1), temporary: { fixedBy: 'x' } },
      'maintenance-authority.json': { kind: 'single-key', signingKey: sk(2), temporary: { fixedBy: 'x' } },
    }));
    expect(held).toEqual([vk(1), vk(2)]);
  });

  it('are none when the files are absent, unreadable or say a committee', () => {
    expect(keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, () => null)).toEqual([]);
    expect(keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, () => 'not json')).toEqual([]);
    expect(keysThisMachineHolds('/r', '/r/.midnight', 'payroll', derive, files({
      'vault-authority-payroll.json': { kind: 'committee', committee: [vk(1)], threshold: 1 },
    }))).toEqual([]);
  });
});

/*
 * **ONE GATE, BOTH DOORS, ONE TABLE.**
 *
 * Every row below is one situation on the chain. It is put to the operator
 * door through its own entry point, and to the product's route through the
 * facts that route assembles, and the two answers are compared. A row that
 * says `both` is a situation the two doors must not disagree about; a row that
 * says `apart` is the one difference that is kept on purpose, and it is
 * asserted in both directions so that closing it silently turns this red.
 *
 * RED WHEN, per row: the named condition stops being read by either door. Each
 * was watched red by removing that one condition from `refusalToPutMoneyIn` and
 * running this file, and each mutation's own output is recorded with the change
 * that made it.
 */

/** A chain that answers differently per address, which is the whole point of the account half. */
const chain = (at: Record<string, unknown>) => async (address: string) => {
  const found = at[address];
  if (found === undefined) return null;
  if (found === 'down') throw new Error('down');
  return { maintenanceAuthority: found };
};

const HELD_BY_US = { committee: [vk(9)], threshold: 1, counter: 0n };
const THE_COMMITTEE: Committee = { committee: [vk(3), vk(4), vk(5)] as never, threshold: 2 };
const HANDED_OVER = { committee: [vk(3), vk(4), vk(5)], threshold: 2, counter: 1n };
const SOLO = { committee: [vk(3)], threshold: 1, counter: 1n };

/** The facts the product's route assembles, for a chain and a committee it can read. */
const serviceAsks = async (
  at: Record<string, unknown>, committee: Committee | null,
  over: Partial<FundingFacts> = {},
): Promise<string | null> => {
  const read = chain(at);
  const facts: FundingFacts = {
    label: VAULT,
    what: 'no money goes into this vault',
    vault: await readContractAuthority(read, VAULT),
    vaultCircuits: null,
    pinnedAccount: ACCOUNT,
    companyAccount: ACCOUNT,
    account: await readContractAuthority(read, ACCOUNT),
    accountCircuits: null,
    committee,
    heldHere: [vk(9)] as never,
    ...over,
  };
  return refusalToPutMoneyIn(facts)?.why ?? null;
};

/**
 * The operator door, through the entry point the two scripts actually call.
 * `over` carries the conditions the caller states rather than the gate reads,
 * so a row that says BOTH really drives BOTH and not the gate twice.
 */
const operatorAsks = (
  at: Record<string, unknown>,
  over: { pinnedAccount?: string | null; vaultCircuits?: string | null; accountCircuits?: string | null } = {},
): Promise<string | null> => refusalToFund({
  vault: VAULT, vaultName: 'payroll', account: ACCOUNT, readState: chain(at), held: [vk(9)] as never,
  pinnedAccount: ACCOUNT, vaultCircuits: null, accountCircuits: null, ...over,
});

describe('ONE GATE, AND BOTH DOORS ASK IT', () => {
  it('BOTH FUND a vault and an account the committee holds, each changed once', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    expect(await operatorAsks(at)).toBeNull();
    expect(await serviceAsks(at, THE_COMMITTEE)).toBeNull();
  });

  /*
   * The defect this file exists for. Before the fix, the operator door read the
   * vault's rules and nothing else, so this row funded from a script and was
   * refused by the screen.
   */
  it('BOTH REFUSE a vault the committee holds while the ACCOUNT is still on this machine\'s key', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HELD_BY_US };
    /* Both name the ACCOUNT, and both name the one press that resolves it. */
    for (const why of [await operatorAsks(at), await serviceAsks(at, THE_COMMITTEE)]) {
      expect(why).toMatch(/account is still held by the temporary key it was created with/);
      expect(why).toMatch(/Hand the account to the company's committee in Settings first/);
    }
    /* And where the account is held by keys that are nobody's here, the account is still what is named. */
    const strangers = { [VAULT]: HANDED_OVER, [ACCOUNT]: { committee: [vk(7), vk(8)], threshold: 2, counter: 3n } };
    expect(await operatorAsks(strangers)).toMatch(/changed 3 times/);
    expect(await serviceAsks(strangers, THE_COMMITTEE)).toMatch(/account, which every vault pays out on/);
  });

  it('BOTH REFUSE a vault still held by a single key', async () => {
    const at = { [VAULT]: HELD_BY_US, [ACCOUNT]: HANDED_OVER };
    expect(await operatorAsks(at)).toMatch(/a key this machine keeps/);
    expect(await serviceAsks(at, THE_COMMITTEE)).toMatch(/not held by the company's committee/);
  });

  it('BOTH REFUSE a chain that cannot be asked, about either contract', async () => {
    for (const at of [
      { [VAULT]: 'down', [ACCOUNT]: HANDED_OVER },
      { [VAULT]: HANDED_OVER, [ACCOUNT]: 'down' },
    ]) {
      expect(await operatorAsks(at)).toMatch(/could not be asked/);
      expect(await serviceAsks(at, THE_COMMITTEE)).toMatch(/could not be asked/);
    }
  });

  /*
   * Read by the product's route from the moment it existed and by no operator
   * tool until this change: a key that held the rules could have swapped a
   * circuit, used it and put it back, so anything changed more than once
   * cannot be vouched for.
   */
  it('BOTH REFUSE rules changed more than once, on the vault and on the account', async () => {
    for (const at of [
      { [VAULT]: { ...HANDED_OVER, counter: 2n }, [ACCOUNT]: HANDED_OVER },
      { [VAULT]: HANDED_OVER, [ACCOUNT]: { ...HANDED_OVER, counter: 2n } },
    ]) {
      expect(await operatorAsks(at)).toMatch(/changed 2 times/);
      expect(await serviceAsks(at, THE_COMMITTEE)).toMatch(/changed 2 times/);
    }
  });

  /*
   * **DRIVEN THROUGH THE OPERATOR'S OWN ENTRY POINT, NOT THROUGH THE GATE WITH
   * `committee: null`.** The first version of these two rows called the gate
   * directly and named the operator door in the sentence; deleting
   * `funding-gate.ts` outright would have left both green. Found by this
   * round's own audit.
   */
  it('BOTH REFUSE a vault the chain says is pinned to an account that is not the company\'s', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    const elsewhere = 'ef'.repeat(32);
    expect(await operatorAsks(at, { pinnedAccount: elsewhere }))
      .toMatch(/pinned to an account other than the company's/);
    expect(await serviceAsks(at, THE_COMMITTEE, { pinnedAccount: elsewhere }))
      .toMatch(/pinned to an account other than the company's/);
    /* And a vault whose state cannot be read as a vault's is refused, not passed. */
    expect(await operatorAsks(at, { pinnedAccount: null })).toMatch(/cannot be read as a vault's/);
    expect(await serviceAsks(at, THE_COMMITTEE, { pinnedAccount: null })).toMatch(/cannot be read as a vault's/);
  });

  it('BOTH REFUSE circuits that are not this build\'s, WHEN THE DOOR READS THEM', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    const notOurs = 'its circuits are not this build\'s';
    expect(await operatorAsks(at, { vaultCircuits: notOurs })).toBe(notOurs);
    expect(await serviceAsks(at, THE_COMMITTEE, { vaultCircuits: notOurs })).toBe(notOurs);
    expect(await operatorAsks(at, { accountCircuits: notOurs })).toBe(notOurs);
    expect(await serviceAsks(at, THE_COMMITTEE, { accountCircuits: notOurs })).toBe(notOurs);
  });

  /*
   * **AND THE GAP THE OPERATOR DOOR LEAVES, PINNED AS A GAP.** Its two callers
   * pass `null` for both circuits without reading them, so this row is what the
   * product actually does today. It turns red the moment a caller starts
   * reading them, which is the point: the gap is then closed and this row says
   * so rather than being quietly still true.
   */
  it('AND THE OPERATOR DOOR DOES NOT READ CIRCUITS AT ALL - its callers pass null unread', async () => {
    const { readFileSync } = await import('node:fs');
    for (const door of ['fund-vault.ts', 'deposit-to-vault.ts'] as const) {
      const text = readFileSync(new URL(`./${door}`, import.meta.url), 'utf8');
      const asked = text.indexOf('await refusalToFund({');
      const call = text.slice(asked, text.indexOf('});', asked));
      expect(call, door).toContain('vaultCircuits: null');
      expect(call, door).toContain('accountCircuits: null');
      /* The pin, by contrast, IS read from the chain and is not the record's own value. */
      expect(call, door).toContain('pinnedAccount,');
      expect(text.slice(0, asked), door).toContain('queryContractState(entry.contractAddress)');
    }
  });

  /*
   * **THE ONE DIFFERENCE KEPT ON PURPOSE, ASSERTED IN BOTH DIRECTIONS.** A door
   * with the company's roster can tell a company that deliberately has one
   * signer from a vault nobody has handed over. A door without one cannot, so
   * it asks the stricter question. Neither door was made weaker to agree.
   */
  it('DIFFER, AND ON PURPOSE, about a company that deliberately has one signer', async () => {
    const at = { [VAULT]: SOLO, [ACCOUNT]: SOLO };
    const solo: Committee = { committee: [vk(3)] as never, threshold: 1 };
    expect(await serviceAsks(at, solo)).toBeNull();
    expect(await operatorAsks(at)).toMatch(/still held by a single key/);
  });

  /* The same difference where the committee has members but any one of them can act alone. */
  it('DIFFER, AND ON PURPOSE, about a committee of two that either member can use alone', async () => {
    const either = { committee: [vk(3), vk(4)], threshold: 1, counter: 1n };
    const at = { [VAULT]: either, [ACCOUNT]: either };
    const asAsked: Committee = { committee: [vk(3), vk(4)] as never, threshold: 1 };
    expect(await serviceAsks(at, asAsked)).toBeNull();
    expect(await operatorAsks(at)).toMatch(/any one member of its committee can change which proofs it accepts/);
  });
});

describe('BOTH FUNDING DOORS ASK BEFORE THEY DEPOSIT', () => {
  it('reads the chain and stops on a refusal, before the deposit call', async () => {
    const { readFileSync } = await import('node:fs');
    for (const [door, call] of [['fund-vault.ts', 'ledger.depositUnshielded('], ['deposit-to-vault.ts', 'ledger.deposit(']] as const) {
      const text = readFileSync(new URL(`./${door}`, import.meta.url), 'utf8');
      const asked = text.indexOf('await refusalToFund({');
      const stopped = text.indexOf('if (refusal !== null) throw new Error(refusal);', asked);
      const deposited = text.indexOf(call);
      expect(asked, door).toBeGreaterThan(-1);
      expect(stopped, door).toBeGreaterThan(asked);
      expect(deposited, door).toBeGreaterThan(stopped);
      expect(text.slice(asked, stopped)).toContain('providers.publicDataProvider.queryContractState');
      /* The account half is the point: a door that stopped passing it would fund on half the question. */
      expect(text.slice(asked, stopped), door).toContain('account: entry.accountAddress');
    }
  });
});
