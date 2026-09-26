import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  argumentsFor, buildGovernedCall, CallNotBuilt, NotReadByAnApproval, recordForOneCall, RecordChangedByTheCall,
  refuseARaiseThatIsNotTheRecordedOne,
  type GovernedCallDeps, type GovernedCallOrder, type OpenedRound, type GovernanceOnTheWire,
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
const run = { root: '88'.repeat(32), payees: '3', opensAt: '100', closesAt: '200', vault: '99'.repeat(32) };
/* The contract's two pure functions, stood in for by hashes over the same parts. */
const sha = (...parts: Array<Uint8Array | bigint>) => Uint8Array.from(createHash('sha256')
  .update(Buffer.concat(parts.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : Buffer.from(p.toString()))))).digest());
const accountPure = {
  runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint) => sha(root, payees, opensAt, closesAt),
  proposalIdOf: (payload: Uint8Array, vault: Uint8Array, salt: Uint8Array) => sha(payload, vault, salt),
  signerAddPayload: (leaf: Uint8Array) => sha(Buffer.from('seat'), leaf),
  setThresholdPayload: (t: bigint) => sha(Buffer.from('threshold'), t),
  noVault: () => new Uint8Array(32).fill(0xfe),
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
const payloadOf = (g: GovernanceOnTheWire) => (g.kind === 'add-signer'
  ? accountPure.signerAddPayload(bytes(g.leaf)) : accountPure.setThresholdPayload(BigInt(g.threshold)));
const recordOf = (digest: Uint8Array, vault: Uint8Array, salt: string) => ({
  chainId: hex(accountPure.proposalIdOf(digest, vault, bytes(salt))), digest: hex(digest), vault: hex(vault), salt,
  summary: 'the proposal',
});
const halfOf = (h: typeof half) => ({ assetId: h.assetId, changeAmount: h.changeAmount, changeBatchDigest: h.changeBatchDigest });
const openedFor = (order: GovernedCallOrder): OpenedRound => {
  const o = order as any;
  if (o.circuit === 'propose' && o.run) {
    const r = o.run;
    return {
      ...recordOf(accountPure.runPayload(bytes(r.root), BigInt(r.payees), BigInt(r.opensAt), BigInt(r.closesAt)),
        bytes(r.vault), o.half.proposalSalt),
      half: halfOf(o.half),
    };
  }
  if (o.circuit === 'propose') {
    return { ...recordOf(payloadOf(o.governance), accountPure.noVault(), o.half.proposalSalt), governance: o.governance, half: halfOf(o.half) };
  }
  if (o.circuit === 'amendSigner') {
    const g = { kind: 'add-signer', leaf: o.leaf } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  if (o.circuit === 'setThreshold') {
    const g = { kind: 'threshold', threshold: o.threshold } as const;
    return { ...recordOf(payloadOf(g), accountPure.noVault(), o.proposalSalt), governance: g };
  }
  if (o.of) return { ...recordOf(payloadOf(o.of.governance), accountPure.noVault(), o.of.proposalSalt), governance: o.of.governance };
  const { half: _h, ...record } = openedFor(raise);
  return record;
};
type Input = Parameters<typeof buildGovernedCall>[1];
const build = (deps: GovernedCallDeps, input: Omit<Input, 'opened'> & { opened?: OpenedRound }) =>
  buildGovernedCall(deps, { ...input, opened: input.opened ?? openedFor(input.order) });

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
    expect(argumentsFor(raise)).toEqual([new Uint8Array(32), bytes(run.root), 3n, 100n, 200n, true, bytes(run.vault)]);
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
    const [{ options, zk }] = handed;
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

  it('THE RECORD IS FROZEN FOR THE CALL: a circuit that writes into it fails there', async () => {
    const refused = await build(depsWith([], [], {
      build: async (options) => { options.initialPrivateState.proposalSalt = new Uint8Array(32); return { private: { nextPrivateState: options.initialPrivateState, unprovenTx: 'U' } }; },
    }), { account: ACCOUNT, order: raise, material, chain }).catch((e) => e);
    /* RED WHEN: a write into the record in place goes through unnoticed. */
    expect(refused).toBeInstanceOf(TypeError);
  });

  it('ONLY A RAISE, AN APPROVAL, A SEAT OR A THRESHOLD, ONLY FOR AN ACCOUNT ADDRESS, AND NOTHING IS BUILT OTHERWISE', async () => {
    for (const circuit of ['cancel', 'closeExpiredRun', 'recordPayment', 'setVaultThreshold', 'adopt', 'toString']) {
      const log: string[] = [];
      /* RED WHEN: a circuit a device does not govern here - or one open to anybody - is built with a signer's record. */
      await expect(build(depsWith(log, []), {
        account: ACCOUNT, order: { circuit, proposal: 'aa'.repeat(32) } as unknown as GovernedCallOrder, material, chain,
      })).rejects.toThrow(/raises and approves proposals, seats signers and changes the threshold/u);
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
      accountPure.signerAddPayload(bytes(LEAF)), new Uint8Array(32), 0n, 0n, 0n, false, accountPure.noVault(),
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
