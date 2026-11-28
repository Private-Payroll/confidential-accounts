import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ReleasedVersion } from 'midnight-identity/wallet/released-versions';
import {
  BLOCK_QUERY,
  TIP_QUERY,
  deploysInBlock,
  emptyTally,
  startHeight,
  tallyLines,
  tipOf,
  verdictOfState,
  walkBlocks,
  withVerdict
} from './count-companies-rules.js';

/* The count door's decisions: what a deploy is in a block's answer, what a contract's keys come to, how they are tallied. */
const enc = new TextEncoder();
const HEADER = { v2: 'midnight:verifier-key[v6]:', v3: 'midnight:verifier-key[v7]:' } as const;
const keyFile = (slot: keyof typeof HEADER, seed: number): Uint8Array =>
  Uint8Array.from([
    ...enc.encode(HEADER[slot]),
    48 << 2,
    ...Array.from({ length: 48 }, (_, i) => (i * seed + 11) & 255)
  ]);
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const stateHex = (ops: Record<string, readonly Uint8Array[]>): string => {
  const s = new L.ContractState();
  for (const [name, keys] of Object.entries(ops)) {
    const op = new L.ContractOperation();
    for (const k of keys) op.verifierKey = k;
    s.setOperation(name, op);
  }
  return hexOf(s.serialize());
};

const ADOPT_V2 = keyFile('v2', 5);
const ADOPT_V3 = keyFile('v3', 7);
const STRANGER_V2 = keyFile('v2', 13);
const DEPOSIT = keyFile('v3', 19);
const PUT = keyFile('v3', 3);
const VERSIONS: readonly ReleasedVersion[] = [
  {
    version: 7,
    reachedFrom: [],
    openRunsFinishFirst: false,
    withdrawn: false,
    keys: {
      account: { adopt: { v2: hexOf(sha256(ADOPT_V2)), v3: hexOf(sha256(ADOPT_V3)) } },
      vault: { deposit: { v3: hexOf(sha256(DEPOSIT)) } },
      registry: { put: { v3: hexOf(sha256(PUT)) } }
    }
  }
];
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);

const blockWith = (actions: unknown[][]) => ({
  data: { block: { height: 5, transactions: actions.map((contractActions) => ({ contractActions })) } }
});

describe("what counts as a deploy in a block's answer", () => {
  it('COUNTS A CONTRACT DEPLOY AND NOTHING ELSE', () => {
    const answer = blockWith([
      [
        { __typename: 'ContractDeploy', address: A },
        { __typename: 'ContractCall', address: B }
      ],
      [{ __typename: 'ContractUpdate', address: B }]
    ]);
    /* RED WHEN a call or an update of a contract is counted as a deploy, or a deploy is not. */
    expect(deploysInBlock(answer)).toEqual({ of: 'block', deploys: [A] });
  });

  it('A BLOCK WITH NO ACTIONS HAS NO DEPLOYS, AND A DEPLOY SEEN TWICE IS ONE', () => {
    expect(deploysInBlock(blockWith([[], []]))).toEqual({ of: 'block', deploys: [] });
    expect(
      deploysInBlock(
        blockWith([
          [{ __typename: 'ContractDeploy', address: A }],
          [{ __typename: 'ContractDeploy', address: A.toUpperCase() }]
        ])
      )
    ).toEqual({ of: 'block', deploys: [A] });
  });

  it('A BLOCK THE INDEXER DOES NOT HOLD IS SAID NOT TO BE HELD, NEVER AN EMPTY BLOCK', () => {
    /* RED WHEN a null block is read as a block with no deploys. */
    expect(deploysInBlock({ data: { block: null } })).toEqual({ of: 'no-block' });
  });

  it.each([
    ['errors', { errors: [{ message: 'x' }], data: { block: null } }],
    ['no data', {}],
    ['not an object', 'x'],
    ['no transactions list', { data: { block: { height: 1 } } }],
    ['a transaction with no actions list', { data: { block: { transactions: [{}] } } }],
    ['an action with no type', blockWith([[{ address: A }]])],
    ['a deploy with a short address', blockWith([[{ __typename: 'ContractDeploy', address: 'abcd' }]])],
    ['a deploy with no address', blockWith([[{ __typename: 'ContractDeploy' }]])]
  ])('AN ANSWER THAT CANNOT BE READ WHOLE (%s) IS UNREAD, NEVER A BLOCK WITH NO DEPLOYS', (_what, answer) => {
    /* RED WHEN a half-read block is passed over as empty: a skipped deploy would be a company never counted. */
    expect(deploysInBlock(answer).of).toBe('unread');
  });

  it('ASKS FOR THE BLOCK BY HEIGHT AND FOR ITS DEPLOYS, NOT FOR ANY STATE', () => {
    expect(BLOCK_QUERY).toContain('block(offset: { height: $height })');
    expect(BLOCK_QUERY).toContain('__typename address');
    expect(BLOCK_QUERY).not.toMatch(/\bstate\b/u);
    expect(TIP_QUERY).toBe('query { block { height } }');
  });

  it('READS THE TIP ONLY FROM A WHOLE ANSWER', () => {
    expect(tipOf({ data: { block: { height: 120 } } })).toBe(120);
    for (const bad of [
      { data: { block: null } },
      { data: { block: { height: -1 } } },
      { data: { block: { height: '5' } } },
      { errors: [], data: { block: { height: 1 } } },
      null
    ]) {
      expect(tipOf(bad)).toBeNull();
    }
  });
});

describe("what a deployed contract's keys come to", () => {
  it("NAMES THE CONTRACT AND VERSION WHEN EVERY KEY IN EVERY SLOT IS A PUBLISHED VERSION'S", () => {
    expect(verdictOfState(stateHex({ adopt: [ADOPT_V2, ADOPT_V3] }), A, VERSIONS)).toEqual({
      of: 'published',
      contract: 'account',
      version: 7
    });
    expect(verdictOfState(stateHex({ deposit: [DEPOSIT] }), A, VERSIONS)).toEqual({
      of: 'published',
      contract: 'vault',
      version: 7
    });
    expect(verdictOfState(stateHex({ put: [PUT] }), A, VERSIONS)).toEqual({
      of: 'published',
      contract: 'registry',
      version: 7
    });
  });

  it('A KEY HIDDEN IN THE OTHER SLOT MATCHES NONE', () => {
    /* RED WHEN only the slot the ledger shows is judged: the stranger's key hides behind the build's own. */
    expect(verdictOfState(stateHex({ adopt: [STRANGER_V2, ADOPT_V3] }), A, VERSIONS)).toEqual({ of: 'matches-none' });
    expect(verdictOfState(stateHex({ deposit: [STRANGER_V2, DEPOSIT] }), A, VERSIONS)).toEqual({ of: 'matches-none' });
  });

  it('A CONTRACT OF ANOTHER SHAPE MATCHES NONE', () => {
    expect(verdictOfState(stateHex({ somethingElse: [DEPOSIT] }), A, VERSIONS)).toEqual({ of: 'matches-none' });
  });

  it('A WITHDRAWN VERSION IS NOT A PUBLISHED ONE', () => {
    const withdrawn = [{ ...VERSIONS[0]!, withdrawn: true }];
    expect(verdictOfState(stateHex({ adopt: [ADOPT_V2, ADOPT_V3] }), A, withdrawn)).toEqual({ of: 'matches-none' });
  });

  it.each([[null], ['00ff00ff']])(
    'A STATE THAT WAS NOT GOT (%s) COULD NOT BE CHECKED, WHICH IS NOT "MATCHES NONE"',
    (hex) => {
      /* RED WHEN a state that was not read is counted among the contracts that match no published version. */
      expect(verdictOfState(hex, A, VERSIONS).of).toBe('unchecked');
    }
  );
});

describe('the tally', () => {
  const published = (contract: 'account' | 'vault' | 'registry', version: number) =>
    ({ of: 'published', contract, version }) as const;

  it('COUNTS PER CONTRACT AND VERSION, AND THOSE THAT MATCH NONE, AND THOSE NOT CHECKED, APART', () => {
    let t = emptyTally();
    for (const v of [
      published('account', 7),
      published('account', 7),
      published('account', 8),
      published('vault', 7),
      { of: 'matches-none' } as const,
      { of: 'unchecked', why: 'x' } as const
    ])
      t = withVerdict(t, v);
    /* RED WHEN a verdict is added to the wrong bucket, or two versions share a count. */
    expect(t).toEqual({
      deploys: 6,
      byContract: { account: { 7: 2, 8: 1 }, vault: { 7: 1 }, registry: {} },
      matchesNone: 1,
      unchecked: 1
    });
  });

  it('LEAVES THE TALLY IT WAS GIVEN UNCHANGED', () => {
    const t = emptyTally();
    withVerdict(t, published('account', 7));
    expect(t).toEqual(emptyTally());
  });

  it('SAYS IN PLAIN WORDS WHAT WAS COUNTED, AND WHICH BLOCKS', () => {
    const t = withVerdict(withVerdict(emptyTally(), published('account', 7)), { of: 'matches-none' });
    expect(tallyLines(t, { from: 10, to: 20 })).toEqual([
      'Counted blocks 10 to 20: 2 contract deploys.',
      '  account: 1 built from our published code (version 7: 1)',
      '  vault: 0 built from our published code',
      '  registry: 0 built from our published code',
      '  Contracts that match no published version: 1',
      '  Contracts that could not be checked: 0'
    ]);
    expect(tallyLines(emptyTally(), { from: 10, to: null })[0]).toBe('No block was counted: 0 contract deploys.');
  });
});

describe('where a walk starts and resumes', () => {
  it('STARTS AT THE FIRST BLOCK WITH NO ARGUMENT, AND AT THE HEIGHT GIVEN', () => {
    expect(startHeight(undefined, 100)).toEqual({ of: 'ok', height: 0 });
    expect(startHeight('', 100)).toEqual({ of: 'ok', height: 0 });
    expect(startHeight('42', 100)).toEqual({ of: 'ok', height: 42 });
    expect(startHeight('100', 100)).toEqual({ of: 'ok', height: 100 });
  });

  it.each(['abc', '-1', '1.5', '101', '0x10'])('REFUSES %j AS A START', (arg) => {
    expect(startHeight(arg, 100).of).toBe('refused');
  });
});

/* A scripted chain: which contracts are deployed at which height, and what state each address holds. */
const ACCOUNT_A = 'a0'.repeat(32);
const ACCOUNT_B = 'a1'.repeat(32);
const VAULT_V = 'b0'.repeat(32);
const STRANGER = 'c0'.repeat(32);
const ADDRESSES = {
  [ACCOUNT_A]: stateHex({ adopt: [ADOPT_V2, ADOPT_V3] }),
  [ACCOUNT_B]: stateHex({ adopt: [ADOPT_V2, ADOPT_V3] }),
  [VAULT_V]: stateHex({ deposit: [DEPOSIT] }),
  [STRANGER]: stateHex({ other: [DEPOSIT] })
};
const DEPLOYED: Readonly<Record<number, readonly string[]>> = {
  3: [ACCOUNT_A],
  5: [STRANGER],
  9: [VAULT_V],
  11: [ACCOUNT_B]
};

const answerFor = (height: number) => ({
  data: {
    block: {
      height,
      transactions: [
        {
          contractActions: (DEPLOYED[height] ?? []).map((address) => ({ __typename: 'ContractDeploy', address }))
        }
      ]
    }
  }
});

/** Doors over the scripted chain; `over` replaces how a height is answered or how an address is read. */
function chain(
  over: {
    ask?: (height: number) => Promise<unknown>;
    read?: (address: string) => Promise<string | null>;
    readTimeoutMs?: number;
  } = {}
) {
  const asked: number[] = [];
  return {
    asked,
    doors: {
      ask: async (_query: string, variables: Record<string, unknown>) => {
        const h = variables.height as number;
        asked.push(h);
        return (over.ask ?? (async (x) => answerFor(x)))(h);
      },
      read: over.read ?? (async (address: string) => ADDRESSES[address] ?? null),
      versions: VERSIONS,
      ...(over.readTimeoutMs === undefined ? {} : { readTimeoutMs: over.readTimeoutMs })
    }
  };
}

const sum = (a: ReturnType<typeof emptyTally>, b: ReturnType<typeof emptyTally>) => ({
  deploys: a.deploys + b.deploys,
  matchesNone: a.matchesNone + b.matchesNone,
  unchecked: a.unchecked + b.unchecked,
  accounts: (a.byContract.account?.[7] ?? 0) + (b.byContract.account?.[7] ?? 0),
  vaults: (a.byContract.vault?.[7] ?? 0) + (b.byContract.vault?.[7] ?? 0)
});

describe('the walk over the blocks', () => {
  it('COUNTS A WHOLE RUN ACROSS GROUPS, AND NEVER ASKS ABOVE THE TIP', async () => {
    const { doors, asked } = chain();
    const walk = await walkBlocks(doors, 0, 12);
    /* RED WHEN a deploy is counted twice or missed across a group, or a height above the tip is asked for. */
    expect(walk.of).toBe('done');
    expect(walk.lastCounted).toBe(12);
    expect(walk.tally).toMatchObject({
      deploys: 4,
      matchesNone: 1,
      unchecked: 0,
      byContract: { account: { 7: 2 }, vault: { 7: 1 } }
    });
    expect(Math.max(...asked)).toBe(12);
    expect([...asked].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it('A TIP INSIDE A GROUP ASKS ONLY UP TO THE TIP', async () => {
    const { doors, asked } = chain();
    const walk = await walkBlocks(doors, 8, 10);
    expect([...asked].sort((a, b) => a - b)).toEqual([8, 9, 10]);
    expect(walk).toMatchObject({ of: 'done', lastCounted: 10 });
  });

  it('A STOP IN THE MIDDLE OF A GROUP COUNTS NOTHING FROM THE STOPPED BLOCK ON, AND RESUMING THERE ADDS UP TO THE WHOLE RUN', async () => {
    const whole = await walkBlocks(chain().doors, 0, 12);
    const stopsAt9 = chain({
      ask: async (h) => {
        if (h === 9) throw new Error('the indexer answered 503.');
        return answerFor(h);
      }
    });
    const first = await walkBlocks(stopsAt9.doors, 0, 12);
    /* RED WHEN the stopped block's deploys are counted, blocks after it in the group are counted, or the resume height is not the stopped block. */
    expect(first).toMatchObject({ of: 'stopped', stoppedIn: 9, lastCounted: 8, why: 'the indexer answered 503.' });
    expect(first.tally.deploys).toBe(2);
    if (first.of !== 'stopped') throw new Error('unreachable');
    const second = await walkBlocks(chain().doors, first.stoppedIn, 12);
    expect(second.of).toBe('done');
    expect(sum(first.tally, second.tally)).toEqual(sum(whole.tally, emptyTally()));
  });

  it('A BLOCK THE INDEXER DOES NOT HOLD BELOW THE TIP IS A STOP, NEVER THE END OF THE CHAIN', async () => {
    const hole = chain({ ask: async (h) => (h === 6 ? { data: { block: null } } : answerFor(h)) });
    const walk = await walkBlocks(hole.doors, 0, 12);
    /* RED WHEN a missing block below the tip ends the walk as done, short of the tip. */
    expect(walk).toMatchObject({ of: 'stopped', stoppedIn: 6, lastCounted: 5 });
  });

  it('A STATE THAT CANNOT BE READ STOPS THE BLOCK IT IS IN, WITH NOTHING OF THAT BLOCK COUNTED', async () => {
    const down = chain({
      read: async (address) => {
        if (address === VAULT_V) throw new Error('the indexer answered 500.');
        return ADDRESSES[address] ?? null;
      }
    });
    const walk = await walkBlocks(down.doors, 0, 12);
    expect(walk).toMatchObject({ of: 'stopped', stoppedIn: 9, lastCounted: 8 });
    expect(walk.tally.byContract.vault).toEqual({});
  });

  it('A STATE READ THAT TAKES TOO LONG IS COUNTED AS COULD NOT BE CHECKED, AND THE WALK GOES ON', async () => {
    const slow = chain({
      read: (address) => (address === ACCOUNT_A ? new Promise(() => {}) : Promise.resolve(ADDRESSES[address] ?? null)),
      readTimeoutMs: 5
    });
    const walk = await walkBlocks(slow.doors, 0, 12);
    /* RED WHEN a read has no time limit (the walk hangs) or a timed-out read is counted as matching none. */
    expect(walk.of).toBe('done');
    expect(walk.tally).toMatchObject({ deploys: 4, unchecked: 1, matchesNone: 1, byContract: { account: { 7: 1 } } });
  });
});
