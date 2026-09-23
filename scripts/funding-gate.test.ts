import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { keysThisMachineHolds, refusalToFund, thisBuildsVerifierKeys } from './funding-gate.js';
import { circuitsRefusal, refusalToPutMoneyIn, type FundingFacts } from '../src/wiring/vault-submission.js';
import type { Committee } from '../src/midnight/vault-committee.js';
import { readContractAuthority } from '../src/midnight/ledger.js';
import { VAULT_CIRCUITS } from '../src/midnight/vault-contract.js';
import { DEPLOYED_CIRCUITS } from '../src/midnight/deferral.js';
import { fromHex } from '../src/core/crypto.js';

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

/**
 * **WHAT THE CHAIN SHOWS BESIDES WHO HOLDS THE RULES**: each contract's
 * circuits and their verifying keys, and the vault's ledger, which names the
 * account it pays out on. By default every circuit is this build's and the
 * vault is pinned to the company's account.
 */
interface OnChain {
  readonly vaultOps?: readonly string[];
  readonly vaultKeyOf?: (circuit: string) => Uint8Array;
  readonly accountKeyOf?: (circuit: string) => Uint8Array;
  readonly vaultData?: unknown;
}
const vkOf = (circuit: string) => new TextEncoder().encode(`vk:${circuit}`);
/** This build's verifying keys, as a door is handed them. */
const BUILT = {
  vault: async () => new Map(VAULT_CIRCUITS.map((c) => [c, vkOf(c)] as const)),
  account: async () => new Map(DEPLOYED_CIRCUITS.map((c) => [c, vkOf(c)] as const)),
};

/**
 * **A VAULT'S LEDGER AS THE COMPILED VAULT WRITES IT**, pinned to the account
 * given. Every row reads the pin through the vault's own compiled ledger,
 * because that is the only reader the operator door has.
 */
const { Contract: VaultContract, ledger: vaultLedger } = await import('../contracts/managed-vault/contract/index.js');
const vaultPinnedTo = async (account: string): Promise<unknown> => {
  const vault = new VaultContract({ noteToSpend: () => { throw new Error('unused'); } } as never);
  const init = await (vault as any).initialState(createConstructorContext({}, '0'.repeat(64)), { bytes: fromHex(account as never) });
  return init.currentContractState.data as unknown;
};
const PINNED_HERE = await vaultPinnedTo(ACCOUNT);
const PINNED_ELSEWHERE = await vaultPinnedTo('ef'.repeat(32));

/** A chain that answers differently per address, which is the whole point of the account half. */
const chain = (at: Record<string, unknown>, on: OnChain = {}) => async (address: string) => {
  const found = at[address];
  if (found === undefined) return null;
  if (found === 'down') throw new Error('down');
  const isVault = address === VAULT;
  return {
    maintenanceAuthority: found,
    operations: () => (isVault ? on.vaultOps ?? VAULT_CIRCUITS : DEPLOYED_CIRCUITS),
    operation: (c: string) => ({ verifierKey: ((isVault ? on.vaultKeyOf : on.accountKeyOf) ?? vkOf)(c) }),
    data: isVault ? on.vaultData ?? PINNED_HERE : {},
  };
};

const HELD_BY_US = { committee: [vk(9)], threshold: 1, counter: 0n };
const THE_COMMITTEE: Committee = { committee: [vk(3), vk(4), vk(5)] as never, threshold: 2 };
const HANDED_OVER = { committee: [vk(3), vk(4), vk(5)], threshold: 2, counter: 1n };
const SOLO = { committee: [vk(3)], threshold: 1, counter: 1n };

/** The facts the product's route assembles, for a chain and a committee it can read. */
const serviceAsks = async (
  at: Record<string, unknown>, committee: Committee | null,
  on: OnChain = {}, over: Partial<FundingFacts> = {},
): Promise<string | null> => {
  const read = chain(at, on);
  const stateOf = async (a: string) => { try { return await read(a); } catch { return null; } };
  const vaultState = await stateOf(VAULT);
  let pinned: string | null;
  try {
    pinned = Array.from((vaultLedger as never as (d: unknown) => { account: { bytes: Uint8Array } })(
      (vaultState as { data?: unknown } | null)?.data).account.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { pinned = null; }
  const facts: FundingFacts = {
    label: VAULT,
    what: 'no money goes into this vault',
    vault: await readContractAuthority(read, VAULT),
    vaultCircuits: circuitsRefusal(vaultState, await BUILT.vault(), 'this vault is not funded'),
    pinnedAccount: pinned,
    companyAccount: ACCOUNT,
    account: await readContractAuthority(read, ACCOUNT),
    accountCircuits: circuitsRefusal(await stateOf(ACCOUNT), await BUILT.account(),
      'no money goes in, because this company\'s account is not the one this service\'s build compiled',
      DEPLOYED_CIRCUITS, 'the account\'s'),
    committee,
    heldHere: [vk(9)] as never,
    ...over,
  };
  return refusalToPutMoneyIn(facts)?.why ?? null;
};

/**
 * The operator door, through the entry point the two scripts actually call,
 * with exactly what they pass. **EVERY FACT IT GETS IS A CHAIN IT READS**: the
 * pin and both contracts' circuits are read by the door from the chain the
 * product's facts are assembled from here. What the product's own route does
 * with the same chain is `src/server/company-vaults.test.ts`.
 */
const operatorAsks = (
  at: Record<string, unknown>, on: OnChain = {},
  verifierKeys: Parameters<typeof refusalToFund>[0]['verifierKeys'] = BUILT,
  readState: (address: string) => Promise<unknown> = chain(at, on),
): Promise<string | null> => refusalToFund({
  vault: VAULT, vaultName: 'payroll', account: ACCOUNT, readState, held: [vk(9)] as never, verifierKeys,
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
      /* RED WHEN: a chain that did not answer is read as one that answered and holds nothing. */
      expect(await operatorAsks(at)).toMatch(/could not be asked: down/);
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
    const elsewhere = { vaultData: PINNED_ELSEWHERE };
    /* RED WHEN: the operator door stops reading the pin from the vault's own state. */
    expect(await operatorAsks(at, elsewhere)).toMatch(/pinned to an account other than the company's/);
    expect(await serviceAsks(at, THE_COMMITTEE, elsewhere)).toMatch(/pinned to an account other than the company's/);
    /* And a vault whose state cannot be read as a vault's is refused, not passed. */
    const notAVault = { vaultData: {} };
    expect(await operatorAsks(at, notAVault)).toMatch(/cannot be read as a vault's/);
    expect(await serviceAsks(at, THE_COMMITTEE, notAVault)).toMatch(/cannot be read as a vault's/);
  });

  /*
   * **THE OPERATOR DOOR READS BOTH CONTRACTS' CIRCUITS, AGAINST THE KEYS THIS
   * BUILD COMPILED.** Until this row existed it passed them as unread, which
   * the gate takes as *this build's*, so a contract at the vault's address
   * that was not this build's vault was funded by a script and refused by the
   * screen.
   */
  it('BOTH REFUSE circuits that are not this build\'s, on the vault and on the account', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    const swapped = (name: string) => (c: string) => (c === name ? vkOf('someone else') : vkOf(c));
    /* RED WHEN: the operator door stops reading the vault's circuits. */
    for (const why of [
      await operatorAsks(at, { vaultKeyOf: swapped('payout') }),
      await serviceAsks(at, THE_COMMITTEE, { vaultKeyOf: swapped('payout') }),
    ]) expect(why).toMatch(/its 'payout' circuit is not the one this service's build compiled/);
    /* RED WHEN: a vault carrying one circuit more than this build's is read as this build's. */
    for (const why of [
      await operatorAsks(at, { vaultOps: [...VAULT_CIRCUITS, 'drain'] }),
      await serviceAsks(at, THE_COMMITTEE, { vaultOps: [...VAULT_CIRCUITS, 'drain'] }),
    ]) expect(why).toMatch(/has circuits other than the vault's own/);
    /* RED WHEN: the operator door stops reading the ACCOUNT's circuits, or reads them against the vault's keys. */
    for (const why of [
      await operatorAsks(at, { accountKeyOf: swapped('approve') }),
      await serviceAsks(at, THE_COMMITTEE, { accountKeyOf: swapped('approve') }),
    ]) expect(why).toMatch(/its 'approve' circuit is not the one this service's build compiled/);
  });

  /* RED WHEN: keys that cannot be read are taken as agreement, or the door throws past its own refusal. */
  it('AND THE OPERATOR DOOR REFUSES, SAYING WHAT RESOLVES IT, WHEN THIS BUILD\'S KEYS CANNOT BE READ', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    for (const keys of [
      { vault: async () => { throw new Error('ENOENT: deposit.verifier'); }, account: BUILT.account },
      { vault: BUILT.vault, account: async () => { throw new Error('ENOENT: approve.verifier'); } },
    ]) {
      const why = await operatorAsks(at, {}, keys as never);
      expect(why).toMatch(/this build's verifying keys could not be read \(ENOENT/);
      expect(why).toMatch(/Build both contracts with their proving keys, then run this again\. Nothing was sent\./);
    }
  });

  /*
   * **EACH ADDRESS IS READ ONCE, AND EVERY FACT ABOUT IT COMES FROM THAT ONE
   * ANSWER.** A chain that moves between two reads must not be able to show
   * the door the committee in one answer and a different pin or circuit in
   * the next. RED WHEN: the door reads an address more than once, or reads a
   * fact from any answer but the first.
   */
  it('READS EACH CONTRACT ONCE, AND TAKES EVERY FACT ABOUT IT FROM THAT ONE ANSWER', async () => {
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    const reads: string[] = [];
    const first = chain(at);
    const later = chain(at, { vaultData: PINNED_ELSEWHERE, vaultKeyOf: () => vkOf('someone else') });
    const moving = async (address: string) => {
      reads.push(address);
      return (reads.filter((a) => a === address).length === 1 ? first : later)(address);
    };
    expect(await operatorAsks(at, {}, BUILT, moving)).toBeNull();
    expect(reads.filter((a) => a === VAULT)).toHaveLength(1);
    expect(reads.filter((a) => a === ACCOUNT)).toHaveLength(1);
  });

  /*
   * **THE KEYS THE SCRIPTS HAND THE DOOR ARE READ FROM THIS BUILD'S OWN
   * ARTEFACTS**, by the same readers the product's server uses. Driven against
   * a folder laid out as the build lays them out, outside this tree.
   */
  it('READS THIS BUILD\'S VERIFYING KEYS FROM THE BUILD\'S OWN ARTEFACTS, the vault\'s and the account\'s apart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'this-builds-keys-'));
    const lay = (dir: string, circuits: readonly string[], keyOf: (c: string) => Uint8Array) => {
      mkdirSync(join(root, 'contracts', dir, 'keys'), { recursive: true });
      for (const c of circuits) writeFileSync(join(root, 'contracts', dir, 'keys', `${c}.verifier`), keyOf(c));
    };
    lay('managed-vault', VAULT_CIRCUITS, vkOf);
    lay('managed', DEPLOYED_CIRCUITS, vkOf);
    const at = { [VAULT]: HANDED_OVER, [ACCOUNT]: HANDED_OVER };
    /* RED WHEN: either reader reads the other contract's keys, or anything but these files. */
    expect(await operatorAsks(at, {}, thisBuildsVerifierKeys(root))).toBeNull();
    lay('managed', ['approve'], () => vkOf('rebuilt'));
    expect(await operatorAsks(at, {}, thisBuildsVerifierKeys(root)))
      .toMatch(/its 'approve' circuit is not the one this service's build compiled/);
    expect(await operatorAsks(at, {}, thisBuildsVerifierKeys(join(root, 'nowhere'))))
      .toMatch(/this build's verifying keys could not be read/);
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
