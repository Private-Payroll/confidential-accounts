import { describe, it, expect } from 'vitest';
import { aRunMadeHere, aLedgerHolding } from './a-run-made-here.test-support.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { createHash } from 'node:crypto';
import {
  argumentsFor, buildGovernedCall, CallNotBuilt, identityOfAChange, NotReadByAnApproval, recordForOneCall, RecordChangedByTheCall,
  refuseARaiseThatIsNotTheRecordedOne,
  type GovernedCallDeps, type GovernedCallOrder, type OpenedRound, type RoundChangeOnTheWire,
} from './governed-call-builder.js';

/*
 * The builder with the call builder and the prover as stand-ins, so every
 * decision the builder makes before and after them can be watched. The real
 * contract runs in `contracts/test/a-run-raised-and-approved-from-the-page.test.ts`.
 */
const ACCOUNT = 'c0'.repeat(32);
const material = { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) };
const half = {
  assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: '66'.repeat(32),
  changeAmount: '30000', changeBatchDigest: '77'.repeat(32),
};
/* A real run of three, made the way the approving device makes it again (`a-run-made-here.test-support.ts`). */
const RUN_MADE = aRunMadeHere({ opensAt: '100', closesAt: '200' });
const run = { root: RUN_MADE.root, payees: '3', opensAt: '100', closesAt: '200', vault: '99'.repeat(32) };
/* The contract's two pure functions, stood in for by hashes over the same parts. */
const sha = (...parts: Array<Uint8Array | bigint>) => Uint8Array.from(createHash('sha256')
  .update(Buffer.concat(parts.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(p.toString()))))).digest());
const accountPure = {
  runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint) => sha(root, payees, opensAt, closesAt),
  proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => sha(payload, vault, salt),
  signerAddPayload: (leaf: Uint8Array) => sha(Buffer.from('seat'), leaf),
  setThresholdPayload: (t: bigint) => sha(Buffer.from('threshold'), t),
  setVaultThresholdPayload: (vault: Uint8Array, t: bigint) => sha(Buffer.from('vault-threshold'), vault, t),
  adoptVaultPayload: (vault: Uint8Array) => sha(Buffer.from('adopt'), vault),
  payKeyPayload: (commitment: Uint8Array) => sha(Buffer.from('pay-key'), commitment),
  noVault: () => new Uint8Array(32).fill(0xfe),
  /* What an approval of a run also reads: the pay-record key's commitment and where it is kept. */
  payKeyCommitmentOf: (key: Uint8Array) => sha(Buffer.from('pay-key-commitment'), key),
  payKeyCommitmentKey: () => sha(Buffer.from('pay-key-at')),
  policyOnKeyOf: (vault: Uint8Array) => sha(Buffer.from('policy-on'), vault),
};
const idOf = (r: typeof run, salt: string) => Buffer.from(accountPure.proposalIdOf(
  accountPure.runPayload(Buffer.from(r.root, 'hex'), BigInt(r.payees), BigInt(r.opensAt), BigInt(r.closesAt)),
  Buffer.from(r.vault, 'hex'), Buffer.from(salt, 'hex'))).toString('hex');
const raise: GovernedCallOrder = { circuit: 'propose', run, half, proposal: idOf(run, half.proposalSalt) };
const approve: GovernedCallOrder = { circuit: 'approve', proposal: idOf(run, half.proposalSalt) };
const chain = { accountState: new Uint8Array([1]), parameters: new Uint8Array([2]) };
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/*
 * **WHAT THE DEVICE OPENED, WHEN THE SERVICE WAS HONEST**: the record the order
 * itself describes. The tests of what the device opened are in
 * `the-device-proves-what-it-opened.test.ts`; here it is the honest case, so
 * every other decision the builder makes can be watched on its own.
 */
const payloadOf = (g: RoundChangeOnTheWire) => (g.kind === 'add-signer'
  ? accountPure.signerAddPayload(bytes(g.leaf))
  : g.kind === 'adopt-vault' ? accountPure.adoptVaultPayload(bytes(g.vault))
    : g.kind === 'pay-key' ? accountPure.payKeyPayload(bytes(g.commitment))
      : g.kind === 'vault-threshold' ? accountPure.setVaultThresholdPayload(bytes(g.vault), BigInt(g.threshold))
        : accountPure.setThresholdPayload(BigInt(g.threshold)));
const recordOf = (digest: Uint8Array, vault: Uint8Array, salt: string) => ({
  chainId: hex(accountPure.proposalIdOf(digest, vault, bytes(salt))), digest: hex(digest), vault: hex(vault), salt,
  summary: 'the proposal',
});
const halfOf = (h: typeof half) => ({ assetId: h.assetId, changeAmount: h.changeAmount, changeBatchDigest: h.changeBatchDigest });
/* What the company's records account for when the run is raised: nothing on the chain beyond them. */
const RAISING = { period: '2026-9', knownRounds: [], knownLeaves: [], knownNonces: [] };
const openedFor = (order: GovernedCallOrder): OpenedRound => {
  const o = order as any;
  if (o.circuit === 'propose' && o.run) {
    const r = o.run;
    return {
      ...recordOf(accountPure.runPayload(bytes(r.root), BigInt(r.payees), BigInt(r.opensAt), BigInt(r.closesAt)),
        bytes(r.vault), o.half.proposalSalt),
      half: halfOf(o.half),
      made: { ...RUN_MADE.made, raising: RAISING },
    };
  }
  if (o.circuit === 'propose') {
    const g = o.governance ?? o.adoption ?? o.payKey;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.half.proposalSalt), governance: g, half: halfOf(o.half) };
  }
  if (o.circuit === 'amendSigner') {
    const g = { kind: 'add-signer', leaf: o.leaf } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  if (o.circuit === 'setThreshold') {
    const g = { kind: 'threshold', threshold: o.threshold } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  if (o.circuit === 'setVaultThreshold') {
    const g = { kind: 'vault-threshold', vault: o.vault, threshold: o.threshold } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  /* A withdrawal names only the proposal: the honest case is the run the raise put on the chain. */
  if (o.circuit === 'cancel') {
    const { half: _h, ...record } = openedFor(raise);
    return record;
  }
  if (o.circuit === 'adopt') {
    const g = { kind: 'adopt-vault', vault: o.vault } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  if (o.circuit === 'sealPayKey') {
    const g = { kind: 'pay-key', commitment: o.commitment } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  if (o.of) return { ...recordOf(payloadOf(o.of.governance), accountPure.noVault(), o.of.proposalSalt), governance: o.of.governance };
  /*
   * An approval of a run is built only for what the device made again; here it
   * is the honest case, the run the order raised (`what-this-device-made.ts`).
   */
  const { half: _h, ...record } = openedFor(raise);
  return { ...record, made: RUN_MADE.made };
};
type Input = Parameters<typeof buildGovernedCall>[1];
/* A raise is built while the chain does not hold the proposal yet; an approval while it does. */
const notYetRaised = () => aLedgerHolding(accountPure.payKeyCommitmentKey(), accountPure.payKeyCommitmentOf(bytes(RUN_MADE.made.payKey)), 'none');
const build = (deps: GovernedCallDeps, input: Omit<Input, 'opened'> & { opened?: OpenedRound }) =>
  buildGovernedCall(input.order.circuit === 'propose' && 'run' in input.order ? { ...deps, accountLedger: notYetRaised } : deps,
    { ...input, opened: input.opened ?? openedFor(input.order) });

type Handed = { options: any; zk: unknown };
const depsWith = (log: string[], handed: Handed[], over: {
  build?: (options: any) => Promise<any>; prove?: () => Promise<{ serialize(): Uint8Array }>;
} = {}): GovernedCallDeps => ({
  ledger: {
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'cpk', encryptionPublicKey: 'epk', clear: () => {} }) },
    ZswapChainState: class { },
    LedgerParameters: { deserialize: (b: Uint8Array) => ({ parameters: [...b] }) },
  },
  runtimeState: { deserialize: (b: Uint8Array) => ({ state: [...b] }) },
  contracts: new Proxy({}, {
    get: (_t, name) => {
      log.push(`reached ${String(name)}`);
      if (name !== 'createUnprovenCallTxFromInitialStates') return undefined;
      return async (zk: unknown, options: any) => {
        handed.push({ options, zk });
        if (over.build) return over.build(options);
        return { private: { nextPrivateState: options.initialPrivateState, unprovenTx: 'UNPROVEN' } };
      };
    },
  }) as GovernedCallDeps['contracts'],
  accountCompiled: 'COMPILED',
  accountZkConfig: 'ZK',
  accountPure,
  /* The chain holds every proposal asked about open. */
  accountLedger: () => aLedgerHolding(accountPure.payKeyCommitmentKey(), accountPure.payKeyCommitmentOf(bytes(RUN_MADE.made.payKey))),
  vaultDetails,
  prove: over.prove ?? (async (u: unknown, circuit?: string) => {
    log.push(`proved ${String(u)} for ${circuit}`);
    return { serialize: () => new Uint8Array([9, 9]) };
  }),
  random: (n) => new Uint8Array(n).fill(7),
});

describe('THE RECORD FOR ONE CALL', () => {
  it('a raise carries the signer\'s three and the whole account half, as bytes, and no membership path', () => {
    const r = recordForOneCall(raise, material);
    /* RED WHEN: any field is dropped or taken from the wrong source. */
    expect(r.secretKey).toEqual(bytes(material.signingSecret));
    expect(r.blinding).toEqual(bytes(material.blinding));
    expect(r.scope).toEqual(bytes(material.scope));
    expect(r.assetId).toEqual(bytes(half.assetId));
    expect(r.assetBlinding).toEqual(bytes(half.assetBlinding));
    expect(r.proposalSalt).toEqual(bytes(half.proposalSalt));
    expect(r.changeAmount).toBe(30000n);
    expect(r.changeBatchDigest).toEqual(bytes(half.changeBatchDigest));
    expect(r.pinnedPath).toBeNull();
    expect('pinAnyLeaf' in r).toBe(false);
  });

  it('an approval carries the signer\'s three, and every account field is a refusal that names itself', () => {
    const r = recordForOneCall(approve, material);
    expect(r.secretKey).toEqual(bytes(material.signingSecret));
    expect(r.scope).toEqual(bytes(material.scope));
    /* RED WHEN: an approval's record answers an account field with a value - a guess the circuit would prove against. */
    for (const field of ['assetBlinding', 'assetId', 'proposalSalt', 'changeAmount', 'changeBatchDigest'] as const) {
      expect(() => r[field]).toThrow(NotReadByAnApproval);
      expect(() => r[field]).toThrow(new RegExp(`"${field}"`, 'u'));
    }
  });

  it('KEY MATERIAL SAVED BEFORE SCOPES IS REFUSED BY NAME, AND AN EMPTY OR SHORT SCOPE WITH IT', () => {
    const { scope: _s, ...before } = material;
    /* RED WHEN: an absent scope is read as any value. */
    expect(() => recordForOneCall(raise, before)).toThrow(/written before vault scopes were recorded/u);
    expect(() => recordForOneCall(approve, { ...material, scope: '' })).toThrow(/written before vault scopes were recorded/u);
    expect(() => recordForOneCall(approve, { ...material, scope: '33'.repeat(31) })).toThrow(/is 31 bytes/u);
  });

  it('a raise whose account half is not thirty-two bytes, or whose amount is not a whole number, is refused', () => {
    for (const field of ['assetId', 'assetBlinding', 'proposalSalt', 'changeBatchDigest'] as const) {
      expect(() => recordForOneCall({ ...raise, half: { ...half, [field]: 'ab'.repeat(31) } }, material)).toThrow(/is not thirty-two bytes/u);
      expect(() => recordForOneCall({ ...raise, half: { ...half, [field]: 'AB'.repeat(32) } }, material)).toThrow(/is not thirty-two bytes/u);
    }
    expect(() => recordForOneCall({ ...raise, half: { ...half, changeAmount: '-1' } }, material)).toThrow(/not a whole number/u);
    expect(() => recordForOneCall({ ...raise, half: { ...half, changeAmount: '1.5' } }, material)).toThrow(/not a whole number/u);
  });
});

describe('THE CIRCUIT\'S ARGUMENTS', () => {
  it('a raise is the merged circuit on its run branch, in the contract\'s order', () => {
    /* RED WHEN: the branch flag, the order or any value changes - the chain then holds another proposal, or none. */
    expect(argumentsFor(raise)).toEqual([new Uint8Array(32), bytes(run.root), 3n, 100n, 200n, 0n, true, bytes(run.vault)]);
    /* RED WHEN: the approvals the run's total needs are not carried into the call - the chain then holds another proposal. */
    expect(argumentsFor({ ...raise, run: { ...run, required: '3' } })[5]).toBe(3n);
  });
  it('an approval is the proposal\'s identity and nothing else', () => {
    expect(argumentsFor(approve)).toEqual([bytes(approve.proposal)]);
  });
  it('a run with nobody in it, or a window that closes before it opens, is refused before anything is built', () => {
    expect(() => argumentsFor({ ...raise, run: { ...run, payees: '0' } })).toThrow(/at least one person/u);
    expect(() => argumentsFor({ ...raise, run: { ...run, opensAt: '200' } })).toThrow(/closes before it opens/u);
    expect(() => argumentsFor({ circuit: 'approve', proposal: 'zz' })).toThrow(/not thirty-two bytes/u);
  });
});

describe('ONE GOVERNED CALL', () => {
  it('reaches one call builder, hands it the record as a value with this account\'s state and the served parameters, and proves for the named circuit', async () => {
    const log: string[] = [];
    const handed: Handed[] = [];
    const out = await build(depsWith(log, handed), { account: ACCOUNT.toUpperCase(), order: raise, material, chain });
    expect(out.proven).toEqual(new Uint8Array([9, 9]));
    /* RED WHEN: any other entry point of the package is reached - one that reads or writes a private-state store among them. */
    expect(log).toEqual(['reached createUnprovenCallTxFromInitialStates', 'proved UNPROVEN for propose']);
    const { options, zk } = handed[0]!;
    expect(zk).toBe('ZK');
    expect(options.compiledContract).toBe('COMPILED');
    expect(options.circuitId).toBe('propose');
    expect(options.contractAddress).toBe(ACCOUNT);
    expect(options.initialContractState).toEqual({ state: [1] });
    expect(options.ledgerParameters).toEqual({ parameters: [2] });
    /* RED WHEN: the call is given a store and a key rather than the record. */
    expect(Object.keys(options).sort()).toEqual([
      'args', 'circuitId', 'coinPublicKey', 'compiledContract', 'contractAddress', 'initialContractState',
      'initialPrivateState', 'initialZswapChainState', 'ledgerParameters',
    ]);
    expect(options.args).toEqual(argumentsFor(raise));
  });

  it('OVERWRITES THE SIGNER\'S THREE WHEN THE CALL IS DONE, AND WHEN THE PROOF FAILS', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: approve, material, chain });
    await expect(build(depsWith([], handed, { prove: async () => { throw new Error('prover gave up'); } }),
      { account: ACCOUNT, order: raise, material, chain })).rejects.toThrow('prover gave up');
    /* RED WHEN: a record keeps the signer's key after its one call. */
    for (const { options } of handed) {
      const r = options.initialPrivateState;
      expect([...r.secretKey, ...r.blinding, ...r.scope].every((b: number) => b === 0)).toBe(true);
    }
    /* The account half is not the signer's, and is left as it was. */
    expect(handed[1]!.options.initialPrivateState.proposalSalt).toEqual(bytes(half.proposalSalt));
  });

  it('EACH CALL IS COMPOSED FROM ITS OWN ORDER: what one call left in its record is never what the next one starts from', async () => {
    const handed: Handed[] = [];
    const saltsAtTheStart: string[] = [];
    const deps = depsWith([], handed, {
      /*
       * A call builder that scribbles over the salt of the record it was handed, as a
       * write into a shared record would, after noting the salt the call started with.
       */
      build: async (options) => {
        const r = options.initialPrivateState;
        if (options.circuitId === 'propose') {
          saltsAtTheStart.push(Buffer.from(r.proposalSalt).toString('hex'));
          /* The record is frozen, so the scribble lands in its bytes, which are the record's own. */
          r.proposalSalt.fill(0xee);
        }
        return { private: { nextPrivateState: r, unprovenTx: 'U' } };
      },
    });
    const second = { ...raise, half: { ...half, proposalSalt: 'bb'.repeat(32) }, proposal: idOf(run, 'bb'.repeat(32)) };
    for (const order of [raise, approve, second, approve]) {
      await build(deps, { account: ACCOUNT, order, material, chain });
    }
    /* RED WHEN: a record is kept between calls - the second raise then starts from what the first left behind. */
    expect(saltsAtTheStart).toEqual(['66'.repeat(32), 'bb'.repeat(32)]);
    expect(new Set(handed.map((h) => h.options.initialPrivateState)).size).toBe(4);
  });

  it('A CALL THAT CHANGED THE RECORD IT WAS HANDED IS REFUSED BEFORE IT IS PROVED, because nothing here would keep the change', async () => {
    const log: string[] = [];
    const deps = depsWith(log, [], {
      build: async (options) => ({ private: { nextPrivateState: { ...options.initialPrivateState }, unprovenTx: 'U' } }),
    });
    /* RED WHEN: a changed record is let through - a circuit's write would then be dropped without a word. */
    await expect(build(deps, { account: ACCOUNT, order: raise, material, chain })).rejects.toThrow(RecordChangedByTheCall);
    expect(log.filter((l) => l.startsWith('proved'))).toEqual([]);
  });

  it('A WITNESS\'S OWN REFUSAL IS BROUGHT UP FROM UNDER THE GENERIC FAILURE, and anything else is left as it was', async () => {
    const wrapped = Object.assign(new Error('Error executing circuit \'propose\''), {
      _tag: 'ContractRuntimeError', cause: new Error('you are not a signer on this account'),
    });
    const refused = await build(depsWith([], [], { build: async () => { throw wrapped; } }),
      { account: ACCOUNT, order: raise, material, chain }).catch((e) => e);
    expect(refused).toBeInstanceOf(CallNotBuilt);
    expect(refused.message).toBe('this proposal could not be built on this device: you are not a signer on this account. Nothing was proved or sent.');
    expect(refused.cause).toBe(wrapped);
    const plain = new Error('something else');
    await expect(build(depsWith([], [], { build: async () => { throw plain; } }),
      { account: ACCOUNT, order: approve, material, chain })).rejects.toBe(plain);
  });

  it('A RAISE WHOSE RUN AND SALT DO NOT MAKE THE IDENTITY THE COMPANY WROTE DOWN IS NOT BUILT', async () => {
    for (const order of [
      { ...raise, proposal: 'ab'.repeat(32) },
      { ...raise, half: { ...half, proposalSalt: 'bb'.repeat(32) } },
      { ...raise, run: { ...run, vault: 'ba'.repeat(32) } },
      { ...raise, run: { ...run, closesAt: '201' } },
    ] as GovernedCallOrder[]) {
      const log: string[] = [];
      /* RED WHEN: the device proves a proposal the service's record does not describe. */
      expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure }, order)).toThrow(/not the one the company wrote down/u);
      /* And against the record the device opened, which now refuses it first, by name. */
      await expect(build(depsWith(log, []), { account: ACCOUNT, order, material, chain, opened: openedFor(raise) }))
        .rejects.toThrow(/does not match the company's own record of this proposal/u);
      expect(log).toEqual([]);
    }
    /* The identity is compared however it is spelled. */
    await build(depsWith([], []), { account: ACCOUNT, order: { ...raise, proposal: raise.proposal.toUpperCase() }, material, chain });
  });

  it('A RUN IS RAISED ONLY AS THIS DEVICE BUILT IT AGAIN, AND ONLY WHILE THE CHAIN DOES NOT HOLD IT YET', async () => {
    const opened = openedFor(raise);
    const otherAmounts = { ...RUN_MADE.made, facts: RUN_MADE.made.facts.map((f, i) => (i === 0 ? { ...f, amount: f.amount + 1n } : f)), raising: RAISING };
    const holdingIt = () => aLedgerHolding(accountPure.payKeyCommitmentKey(), accountPure.payKeyCommitmentOf(bytes(RUN_MADE.made.payKey)));
    for (const [deps, made, says] of [
      [depsWith([], []), undefined, /did not rebuild what this proposal pays/u],
      [depsWith([], []), otherAmounts, /not what this device rebuilt/u],
      [depsWith([], []), { ...RUN_MADE.made }, /did not read what the company's records account for on the chain/u],
    ] as const) {
      const log: string[] = [];
      const { made: _m, ...withoutMade } = opened;
      /* RED WHEN: the raise of a run is proved without the run built again here, built from other amounts, or without the chain's check. */
      await expect(build({ ...deps, contracts: depsWith(log, []).contracts }, {
        account: ACCOUNT, order: raise, material, chain, opened: made === undefined ? withoutMade : { ...withoutMade, made },
      })).rejects.toThrow(says);
      expect(log).toEqual([]);
    }
    {
      const log: string[] = [];
      const zero = { ...opened, half: { ...opened.half!, changeAmount: '0' }, made: otherAmounts };
      /* RED WHEN: a payroll raise whose filer sealed a change of 0 is proved without the run built again here. */
      await expect(build({ ...depsWith([], []), contracts: depsWith(log, []).contracts }, {
        account: ACCOUNT, order: { ...raise, half: { ...(raise as any).half, changeAmount: '0' } } as GovernedCallOrder, material, chain, opened: zero,
      })).rejects.toThrow(/not what this device rebuilt/u);
      expect(log).toEqual([]);
    }
    /* RED WHEN: a raise is proved for a proposal the chain already holds open. */
    await expect(buildGovernedCall({ ...depsWith([], []), accountLedger: holdingIt }, { account: ACCOUNT, order: raise, material, chain, opened }))
      .rejects.toThrow(/already holds this proposal open/u);
  });

  it('THE RECORD IS FROZEN FOR THE CALL: a circuit that writes into it fails there', async () => {
    const refused = await build(depsWith([], [], {
      build: async (options) => { options.initialPrivateState.proposalSalt = new Uint8Array(32); return { private: { nextPrivateState: options.initialPrivateState, unprovenTx: 'U' } }; },
    }), { account: ACCOUNT, order: raise, material, chain }).catch((e) => e);
    /* RED WHEN: a write into the record in place goes through unnoticed. */
    expect(refused).toBeInstanceOf(TypeError);
  });

  it('ONLY A RAISE, AN APPROVAL, A WITHDRAWAL, A SEAT, A THRESHOLD, AN ADOPTION OR THE PAY-RECORD KEY SEALED, ONLY FOR AN ACCOUNT ADDRESS, AND NOTHING IS BUILT OTHERWISE', async () => {
    for (const circuit of ['closeExpiredRun', 'recordPayment', 'holdRun', 'retireVault', 'toString']) {
      const log: string[] = [];
      /* RED WHEN: a circuit a device does not govern here - or one open to anybody - is built with a signer's record. */
      await expect(build(depsWith(log, []), {
        account: ACCOUNT, order: { circuit, proposal: 'aa'.repeat(32) } as unknown as GovernedCallOrder, material, chain,
      })).rejects.toThrow(/raises, approves and withdraws proposals, seats signers, changes the company's or a vault's threshold, adopts a vault and seals the pay-record key/u);
      expect(log).toEqual([]);
    }
    const log: string[] = [];
    await expect(build(depsWith(log, []), { account: 'c0'.repeat(31), order: approve, material, chain }))
      .rejects.toThrow(/not for a company account/u);
    const { scope: _s, ...before } = material;
    await expect(build(depsWith(log, []), { account: ACCOUNT, order: approve, material: before, chain }))
      .rejects.toThrow(/written before vault scopes were recorded/u);
    expect(log).toEqual([]);
  });
});

/* ── SEATING A SIGNER AND CHANGING THE THRESHOLD, FROM THE DEVICE ───────────── */

const LEAF = 'ab'.repeat(32);
const SALT = 'cd'.repeat(32);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
const seatRoundId = (leaf: string, salt: string) => hexOf(accountPure.proposalIdOf(
  accountPure.signerAddPayload(bytes(leaf)), accountPure.noVault(), bytes(salt)));
const thresholdRoundId = (t: bigint, salt: string) => hexOf(accountPure.proposalIdOf(
  accountPure.setThresholdPayload(t), accountPure.noVault(), bytes(salt)));
const seatRaise: GovernedCallOrder = {
  circuit: 'propose', governance: { kind: 'add-signer', leaf: LEAF },
  half: { ...half, proposalSalt: SALT, changeAmount: '0' }, proposal: seatRoundId(LEAF, SALT),
};
const seatIt: GovernedCallOrder = { circuit: 'amendSigner', leaf: LEAF, proposal: seatRoundId(LEAF, SALT), proposalSalt: SALT };
const setIt: GovernedCallOrder = { circuit: 'setThreshold', threshold: '2', proposal: thresholdRoundId(2n, SALT), proposalSalt: SALT };

describe('A SEAT AND A THRESHOLD, BUILT ON THE DEVICE', () => {
  it('a governance raise is the merged circuit on its governance branch, with the contract\'s own payload for the leaf named and its own no-vault', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: seatRaise, material, chain });
    /* RED WHEN: the branch flag, the payload or the vault is not the governance round the leaf makes. */
    expect(handed[0]!.options.args).toEqual([
      accountPure.signerAddPayload(bytes(LEAF)), new Uint8Array(32), 0n, 0n, 0n, 0n, false, accountPure.noVault(),
    ]);
    expect(handed[0]!.options.circuitId).toBe('propose');
  });

  it('seating is amendSigner on its seating branch, appended, for the leaf named and the proposal named', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: seatIt, material, chain });
    /* RED WHEN: a seat is built as a removal, into a vacated slot, or for another leaf or round. */
    expect(handed[0]!.options.args).toEqual([bytes(LEAF), bytes(seatRoundId(LEAF, SALT)), false, false]);
    expect(handed[0]!.options.circuitId).toBe('amendSigner');
  });

  it('a threshold change is setThreshold with the number and the proposal', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: setIt, material, chain });
    expect(handed[0]!.options.args).toEqual([2n, bytes(thresholdRoundId(2n, SALT))]);
    await expect(build(depsWith([], []), {
      account: ACCOUNT, order: { ...setIt, threshold: '0', proposal: thresholdRoundId(0n, SALT) } as GovernedCallOrder, material, chain,
    })).rejects.toThrow(/at least one/u);
  });

  it('A SEAT OR A THRESHOLD CHANGE READS THE PROPOSAL\'S SALT AND NO OTHER ACCOUNT FIELD', () => {
    for (const order of [seatIt, setIt]) {
      const r = recordForOneCall(order, material);
      /* RED WHEN: the salt the proposal's identity is recomputed from is not the one handed over. */
      expect(r.proposalSalt).toEqual(bytes(SALT));
      for (const field of ['assetBlinding', 'assetId', 'changeAmount', 'changeBatchDigest'] as const) {
        expect(() => r[field]).toThrow(NotReadByAnApproval);
      }
    }
  });

  it('A SEAT FOR ANOTHER LEAF, A THRESHOLD OTHER THAN THE PROPOSAL\'S, OR A RAISE WHOSE CHANGE IS NOT THE RECORDED ONE, IS NOT BUILT', async () => {
    for (const order of [
      { ...seatIt, leaf: 'ef'.repeat(32) },
      { ...seatIt, proposalSalt: 'ee'.repeat(32) },
      { ...setIt, threshold: '3' },
      { ...seatRaise, governance: { kind: 'add-signer', leaf: 'ef'.repeat(32) } },
      { ...seatRaise, governance: { kind: 'threshold', threshold: '2' } },
    ] as GovernedCallOrder[]) {
      const log: string[] = [];
      /* RED WHEN: a round approved for one change can carry out another, or a raise proves a change nobody wrote down. */
      expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure }, order)).toThrow(/not the one the company wrote down|not for this change/u);
      const base = order.circuit === 'amendSigner' ? seatIt : order.circuit === 'setThreshold' ? setIt : seatRaise;
      await expect(build(depsWith(log, []), { account: ACCOUNT, order, material, chain, opened: openedFor(base) }))
        .rejects.toThrow(/does not match the company's own record of this proposal/u);
      expect(log).toEqual([]);
    }
  });

  it('a governance round that is neither a seat nor a threshold is not built', async () => {
    const log: string[] = [];
    await expect(build(depsWith(log, []), {
      account: ACCOUNT, order: { ...seatRaise, governance: { kind: 'remove-signer', leaf: LEAF } } as unknown as GovernedCallOrder,
      material, chain, opened: openedFor(seatRaise),
    })).rejects.toThrow(/neither a seat nor a threshold/u);
    expect(log).toEqual([]);
  });
});

describe('AN APPROVAL OF A SEAT OR A THRESHOLD IS BOUND TO THE CHANGE ASKED FOR', () => {
  it('is built when the change and its salt make the proposal named, and refused when they do not', async () => {
    const id = seatRoundId(LEAF, SALT);
    const bound: GovernedCallOrder = { circuit: 'approve', proposal: id, of: { governance: { kind: 'add-signer', leaf: LEAF }, proposalSalt: SALT } };
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: bound, material, chain });
    expect(handed[0]!.options.args).toEqual([bytes(id)]);
    for (const order of [
      { ...bound, of: { governance: { kind: 'add-signer', leaf: 'ef'.repeat(32) }, proposalSalt: SALT } },
      { ...bound, of: { governance: { kind: 'threshold', threshold: '1' }, proposalSalt: SALT } },
      { ...bound, of: { governance: { kind: 'add-signer', leaf: LEAF }, proposalSalt: 'ee'.repeat(32) } },
    ] as GovernedCallOrder[]) {
      const log: string[] = [];
      /* RED WHEN: a device approves a proposal for a change other than the one it was asked to approve. */
      expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure }, order)).toThrow(/not for the change asked for here/u);
      await expect(build(depsWith(log, []), { account: ACCOUNT, order, material, chain, opened: openedFor(bound) }))
        .rejects.toThrow(/does not match the company's own record of this proposal/u);
      expect(log).toEqual([]);
    }
  });
});

describe('ADOPTING A NEW VAULT FROM THE DEVICE THAT CREATED IT', () => {
  const VAULT = 'ab'.repeat(32);
  const salt = '66'.repeat(32);
  const id = hex(accountPure.proposalIdOf(accountPure.adoptVaultPayload(bytes(VAULT)), accountPure.noVault(), bytes(salt)));
  const adopt: GovernedCallOrder = { circuit: 'adopt', vault: VAULT, proposal: id, proposalSalt: salt };

  it('IS BUILT WITH THE VAULT AND THE PROPOSAL, AND THE SALT ITS IDENTITY WAS MADE WITH, AND NOTHING ELSE', async () => {
    const log: string[] = [];
    const handed: Handed[] = [];
    await build(depsWith(log, handed), { account: ACCOUNT, order: adopt, material, chain });
    expect(handed[0]!.options.circuitId).toBe('adopt');
    /* RED WHEN: the adoption is built for another vault or proposal than the one approved. */
    expect(handed[0]!.options.args).toEqual([bytes(VAULT), bytes(id)]);
    expect(handed[0]!.options.initialPrivateState.proposalSalt).toEqual(bytes(salt));
    expect(() => handed[0]!.options.initialPrivateState.assetId).toThrow(NotReadByAnApproval);
  });

  it('REFUSES AN ADOPTION OF ANOTHER VAULT THAN THE PROPOSAL NAMES, BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const other = { ...adopt, vault: 'cd'.repeat(32) } as GovernedCallOrder;
    /* RED WHEN: an approved adoption of one vault carries out the adoption of another. */
    await expect(build(depsWith(log, []), { account: ACCOUNT, order: other, material, chain, opened: openedFor(adopt) }))
      .rejects.toThrow(/vault being adopted/);
    expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure }, other)).toThrow(/another identity/);
    expect(log).toEqual([]);
  });

  it('A RAISE OF THE ADOPTION ROUND COMMITS TO THE CONTRACT\'S OWN PAYLOAD FOR THAT VAULT', async () => {
    const handed: Handed[] = [];
    const g = { kind: 'adopt-vault', vault: VAULT } as const;
    const raiseIt: GovernedCallOrder = { circuit: 'propose', adoption: g, half: { ...half, proposalSalt: salt }, proposal: id };
    await build(depsWith([], handed), { account: ACCOUNT, order: raiseIt, material, chain });
    /* RED WHEN: the proposal raised is not the adoption of this vault, under no vault. */
    expect(handed[0]!.options.args[0]).toEqual(accountPure.adoptVaultPayload(bytes(VAULT)));
    expect(handed[0]!.options.args[7]).toEqual(accountPure.noVault());
  });
});

describe('THE PAY-RECORD KEY COMMITTED AND SEALED, FROM THE FOUNDING SIGNER\'S DEVICE', () => {
  const COMMITMENT = 'ef'.repeat(32);
  const salt = '6a'.repeat(32);
  const id = hex(accountPure.proposalIdOf(accountPure.payKeyPayload(bytes(COMMITMENT)), accountPure.noVault(), bytes(salt)));
  const wrap = ['a1', 'a2', 'a3', 'a4'].map((b) => b.repeat(32));
  const seal: GovernedCallOrder = { circuit: 'sealPayKey', wrap, commitment: COMMITMENT, proposal: id, proposalSalt: salt };

  it('THE SEAL IS BUILT WITH THE FOUR ENTRIES, THE COMMITMENT AND THE PROPOSAL, AND THE SALT ITS IDENTITY WAS MADE WITH', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: seal, material, chain });
    expect(handed[0]!.options.circuitId).toBe('sealPayKey');
    /* RED WHEN: the seal is built with other entries, another commitment or another proposal than the ones named. */
    expect(handed[0]!.options.args).toEqual([wrap.map(bytes), bytes(COMMITMENT), bytes(id)]);
    /* RED WHEN: the circuit is handed another salt than the proposal's, so it recomputes another identity and refuses. */
    expect(handed[0]!.options.initialPrivateState.proposalSalt).toEqual(bytes(salt));
    expect(() => handed[0]!.options.initialPrivateState.assetId).toThrow(NotReadByAnApproval);
  });

  it('REFUSES A SEAL OF ANOTHER KEY THAN THE PROPOSAL COMMITS TO, OR NOT FOUR ENTRIES, BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const other = { ...seal, commitment: 'cd'.repeat(32) } as GovernedCallOrder;
    /* RED WHEN: a round approved for one key seals another. */
    await expect(build(depsWith(log, []), { account: ACCOUNT, order: other, material, chain, opened: openedFor(seal) }))
      .rejects.toThrow(/company's pay-record key/);
    expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure }, other)).toThrow(/another identity/);
    /* RED WHEN: a copy that is not the four entries the account stores is built. */
    await expect(build(depsWith(log, []), { account: ACCOUNT, order: { ...seal, wrap: wrap.slice(0, 3) } as GovernedCallOrder, material, chain }))
      .rejects.toThrow(/four entries of thirty-two bytes/);
    expect(log).toEqual([]);
  });

  it('A RAISE OF THE PROPOSAL COMMITS TO THE CONTRACT\'S OWN PAYLOAD FOR THAT COMMITMENT, AND AN APPROVAL IS OF THAT PROPOSAL', async () => {
    const handed: Handed[] = [];
    const g = { kind: 'pay-key', commitment: COMMITMENT } as const;
    const raiseIt: GovernedCallOrder = { circuit: 'propose', payKey: g, half: { ...half, proposalSalt: salt }, proposal: id };
    await build(depsWith([], handed), { account: ACCOUNT, order: raiseIt, material, chain });
    /* RED WHEN: the proposal raised is not the commitment to this key, under no vault. */
    expect(handed[0]!.options.args[0]).toEqual(accountPure.payKeyPayload(bytes(COMMITMENT)));
    expect(handed[0]!.options.args[7]).toEqual(accountPure.noVault());
    const approveIt: GovernedCallOrder = { circuit: 'approve', proposal: id, of: { governance: g, proposalSalt: salt } };
    await build(depsWith([], handed), { account: ACCOUNT, order: approveIt, material, chain });
    expect(handed[1]!.options.args).toEqual([bytes(id)]);
    /* RED WHEN: an approval this device's own record says is for one key is built when the service names another. */
    await expect(build(depsWith([], []), {
      account: ACCOUNT, order: { ...approveIt, of: { governance: { kind: 'pay-key', commitment: 'cd'.repeat(32) }, proposalSalt: salt } } as GovernedCallOrder,
      material, chain, opened: openedFor(approveIt),
    })).rejects.toThrow(/company's pay-record key/);
    /* RED WHEN: an approval of the proposal for one key passes as the approval of the proposal for another. */
    expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure },
      { ...approveIt, of: { governance: { kind: 'pay-key', commitment: 'cd'.repeat(32) }, proposalSalt: salt } } as GovernedCallOrder))
      .toThrow(/not for the change asked for here/);
  });
});

describe('A VAULT\'S OWN APPROVALS NEEDED, AND A WITHDRAWAL, BUILT ON THE DEVICE', () => {
  const VAULT = 'b1'.repeat(32);
  const vaultChange = { kind: 'vault-threshold', vault: VAULT, threshold: '2' } as const;
  const vaultRoundId = (vault: string, t: bigint, salt: string) => hexOf(accountPure.proposalIdOf(
    accountPure.setVaultThresholdPayload(bytes(vault), t), accountPure.noVault(), bytes(salt)));
  const setTheVault: GovernedCallOrder = { circuit: 'setVaultThreshold', vault: VAULT, threshold: '2', proposal: vaultRoundId(VAULT, 2n, SALT), proposalSalt: SALT };
  const withdraw: GovernedCallOrder = { circuit: 'cancel', proposal: idOf(run, half.proposalSalt) };

  it('a vault\'s change is setVaultThreshold with the vault, the number and the proposal, and reads only the proposal\'s salt', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: setTheVault, material, chain });
    /* RED WHEN: the vault's change is built for another vault, another number or another proposal, or in another order. */
    expect(handed[0]!.options.args).toEqual([bytes(VAULT), 2n, bytes(vaultRoundId(VAULT, 2n, SALT))]);
    expect(handed[0]!.options.circuitId).toBe('setVaultThreshold');
    const r = recordForOneCall(setTheVault, material);
    expect(r.proposalSalt).toEqual(bytes(SALT));
    expect(() => r.assetBlinding).toThrow(NotReadByAnApproval);
  });

  it('A VAULT\'S CHANGE FOR ANOTHER VAULT OR ANOTHER NUMBER THAN THE PROPOSAL\'S IS NOT BUILT', async () => {
    for (const order of [
      { ...setTheVault, vault: 'b2'.repeat(32) },
      { ...setTheVault, threshold: '3' },
      { ...setTheVault, proposalSalt: 'ee'.repeat(32) },
    ] as GovernedCallOrder[]) {
      const log: string[] = [];
      /* RED WHEN: a proposal approved for one vault's approvals carries out another's, or another number. */
      expect(() => refuseARaiseThatIsNotTheRecordedOne({ accountPure }, order)).toThrow(/not for this change/u);
      await expect(build(depsWith(log, []), { account: ACCOUNT, order, material, chain, opened: openedFor(setTheVault) }))
        .rejects.toThrow(/does not match the company's own record of this proposal/u);
      expect(log).toEqual([]);
    }
  });

  it('a withdrawal is cancel with the proposal\'s identity alone, and only for the proposal this device opened', async () => {
    const handed: Handed[] = [];
    await build(depsWith([], handed), { account: ACCOUNT, order: withdraw, material, chain });
    expect(handed[0]!.options.args).toEqual([bytes(idOf(run, half.proposalSalt))]);
    expect(handed[0]!.options.circuitId).toBe('cancel');
    const log: string[] = [];
    /* RED WHEN: a device withdraws whatever proposal it is handed rather than the one it opened. */
    await expect(build(depsWith(log, []), {
      account: ACCOUNT, order: { circuit: 'cancel', proposal: 'dd'.repeat(32) }, material, chain, opened: openedFor(withdraw),
    })).rejects.toThrow(/does not match the company's own record of this proposal/u);
    expect(log).toEqual([]);
  });

  it('A CHANGE\'S IDENTITY IS THE ONE THE CONTRACT\'S OWN FUNCTIONS MAKE FROM ITS PAYLOAD AND SALT, UNDER NO VAULT', () => {
    const id = identityOfAChange({ accountPure }, vaultChange, SALT);
    /* RED WHEN: a device files a proposal under an identity the chain will not compute for the same change. */
    expect(id).toEqual({
      digest: hexOf(accountPure.setVaultThresholdPayload(bytes(VAULT), 2n)), chainId: vaultRoundId(VAULT, 2n, SALT), noVault: hexOf(accountPure.noVault()),
    });
    expect(identityOfAChange({ accountPure }, vaultChange, 'ee'.repeat(32)).chainId).not.toBe(id.chainId);
    expect(identityOfAChange({ accountPure }, { kind: 'threshold', threshold: '2' }, SALT).chainId).toBe(thresholdRoundId(2n, SALT));
    /* A device not given the function for a vault's change makes no identity for one. */
    const { setVaultThresholdPayload: _gone, ...without } = accountPure;
    expect(() => identityOfAChange({ accountPure: without as never }, vaultChange, SALT)).toThrow(/approvals needed, so nothing was built/u);
  });
});
