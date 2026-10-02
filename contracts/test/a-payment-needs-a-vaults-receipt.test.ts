/**
 * A PAYMENT IS RECORDED ONLY WHEN A VAULT REALLY PAID IT.
 *
 * The account records a payment only in `recordPaymentFromVault`, and only with
 * a receipt: one unit of `tokenType(paymentReceiptTag(), payingVault)`, which
 * only that vault can mint, received by the account in the same transaction. A
 * call with nothing minted behind it leaves that token one short, and the
 * network's balancing check refuses the transaction.
 *
 * **WHAT THIS SIMULATOR CAN AND CANNOT SHOW.** The runtime simulator does not run
 * the network's balancing check, so a receipt with no mint behind it is accepted
 * by `AccountSimulator`. The first block below therefore builds the real
 * transaction a direct call makes, with the SDK's own builder, and asks the
 * ledger what it leaves unbalanced. The contract's own refusals - the vault it
 * names, whether that vault was ever adopted, the stricter-vault refusal - are
 * asserts, and the simulator runs those.
 *
 * Every assertion names the change that turns it red.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AccountSimulator, change, privateStateFor, type Change, payoutTreeOf, sumArgsOf,
} from './simulator.js';
import { Contract, pureCircuits } from '../managed/contract/index.js';
import { witnesses } from '../src/witnesses.js';
import { buildPayoutTree, type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { fromHex, toHex } from '../../src/core/crypto.js';
import { keysOnDisk } from './keys-on-disk.js';

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);

const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);

const PAYROLL = bytes(0xa1);
const TREASURY = bytes(0xb2);
const STRANGER = bytes(0xc3);

const CONTRACT_SOURCE = join(import.meta.dirname, '..', 'src', 'ConfidentialAccount.compact');
const KEYS = join(import.meta.dirname, '..', 'managed', 'keys');

/** Raises and approves a run of `payments` naming `vault`, with `approvers` voting. */
const approvedRun = async (
  sim: AccountSimulator, vault: Uint8Array, payments: PayoutLeafInput[], c: Change,
  approvers: ReturnType<typeof privateStateFor>[] = [A, B],
) => {
  const tree = payoutTreeOf(payments);
  const by = approvers[0]!;
  await sim.as(sim.applying(by, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault,
  });
  const id = sim.proposalId(
    pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n), c.salt, vault);
  for (const a of approvers) await sim.as(sim.applying(a, c)).approve(id);
  return { tree, id };
};

const claim = (
  run: { tree: ReturnType<typeof buildPayoutTree>; id: Uint8Array },
  payments: PayoutLeafInput[], vault: Uint8Array, c: Change, i: number,
  payingVault?: Uint8Array,
) => ({
  proposal: run.id, vault, payingVault, root: fromHex(run.tree.root), payees: run.tree.payees,
  from: OPENS, until: CLOSES, salt: c.salt,
  details: fromHex(payments[i]!.details), nonce: fromHex(payments[i]!.nonce), ...sumArgsOf(run.tree, i),
});

const oneRun = (seed: number): PayoutLeafInput[] =>
  [{ details: toHex(bytes(seed)), nonce: toHex(bytes(seed + 100)) }];

const live = async (devices = [A, B], threshold = 2n) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  return sim;
};

/** The unshielded tokens an effects map records, as [raw token type, amount]. */
const unshielded = (m: Map<any, bigint>) =>
  [...m].map(([t, v]) => [typeof t === 'string' ? t : (t.raw ?? t), v]);

/* ------------------------------------------------------------------ */

const STAND_IN_KEY = existsSync(KEYS)
  ? readdirSync(KEYS).find((f) => f.endsWith('.verifier'))
  : undefined;
/* Every circuit of the account and of the vault has its verifier key on disk, and each is the key this build compiled. */
const ON_DISK = keysOnDisk();
if (!ON_DISK.ok) {
  console.log(`  NOT CHECKED HERE: a direct call was not built as the real transaction, because ${ON_DISK.why}`);
}

/* Both: every key on disk and pinned, and the stand-in key the transaction is signed with. */
const BUILDS_HERE = ON_DISK.ok && STAND_IN_KEY !== undefined;

describe.skipIf(!BUILDS_HERE)("a direct call, built as the real transaction, leaves the vault's receipt unbalanced [needs every verifier key in contracts/managed/keys and contracts/managed-vault/keys, pinned by its module, and the stand-in signing key; `npm run compact` then `npm run compact:vault -- --full` build the keys]", () => {
  /*
   * The transaction is built by the SDK's own `createUnprovenCallTxFromInitialStates`
   * against this contract's compiled circuit, exactly as a caller holding every
   * argument would build it, and nothing is minted in it. The ledger's own
   * `imbalances` then says what the balancing check would find. No proof is made:
   * a verifier key already on disk stands in for each operation's key, because an
   * unproven transaction only needs one to name its key location.
   */
  const build = async (sim: AccountSimulator, args: unknown[]) => {
    const L: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const sdk: any = await import('@midnight-ntwrk/midnight-js-contracts');
    const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
    const { applyNetworkId } = await import('../../src/midnight/network.js');
    await applyNetworkId('undeployed');
    const key = new Uint8Array(readFileSync(join(KEYS, STAND_IN_KEY!)));
    const state: any = sim.contractStateForCall;
    for (const n of state.operations()) {
      const op = new rt.ContractOperation();
      op.verifierKey = key;
      state.setOperation(n, op);
    }
    const compiled = CompiledContract.make('ConfidentialAccount', Contract as any).pipe(
      CompiledContract.withWitnesses(witnesses as any));
    const zk = {
      getVerifierKey: async () => key,
      getVerifierKeys: async (ns: string[]) => ns.map((n) => [n, key]),
      getZKIR: async () => new Uint8Array(),
      getProverKey: async () => new Uint8Array(),
    };
    const out: any = await sdk.createUnprovenCallTxFromInitialStates(zk, {
      compiledContract: compiled,
      circuitId: 'recordPaymentFromVault',
      contractAddress: sim.address,
      coinPublicKey: hex(bytes(7)),
      initialContractState: state,
      initialZswapChainState: new L.ZswapChainState(),
      ledgerParameters: L.LedgerParameters.initialParameters(),
      initialPrivateState: sim.currentPrivateState,
      args,
    }, hex(bytes(8)));
    return { tx: out.private.unprovenTx, L };
  };

  /* The SDK reads the wall clock for the block time, so this run's window is around it. */
  const WALL = Math.floor(Date.now() / 1000);

  it("THE HEADLINE: nothing minted, and the ledger finds the vault's receipt token one short", async () => {
    const sim = await AccountSimulator.liveAccount([A, B], 2n);
    sim.at(WALL);
    await sim.adoptVault(PAYROLL, [A, B]);
    const payments = oneRun(1);
    const tree = payoutTreeOf(payments);
    const from = BigInt(WALL - 3_600);
    const until = BigInt(WALL + 3_600);
    const c = change(0n, 11);
    await sim.as(sim.applying(A, c)).proposeRun({
      root: fromHex(tree.root), payees: tree.payees, from, until, vault: PAYROLL,
    });
    const id = sim.proposalId(pureCircuits.runPayload(fromHex(tree.root), tree.payees, from, until, 0n), c.salt, PAYROLL);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    const { tx, L } = await build(sim, [
      id, PAYROLL, PAYROLL, fromHex(tree.root), tree.payees, from, until, 0n, c.salt,
      fromHex(payments[0]!.details), fromHex(payments[0]!.nonce), tree.amounts[0]!, fromHex(tree.asset),
      tree.pathFor(0),
    ]);
    /* The ledger's own derivation of the vault's token, not the contract's. */
    const receipt = L.rawTokenType(pureCircuits.paymentReceiptTag(), hex(PAYROLL));
    const owed = new Map<string, bigint>();
    for (const [token, amount] of tx.imbalances(0, 0n) as Map<{ tag: string; raw?: string }, bigint>) {
      owed.set(`${token.tag}:${token.raw ?? ''}`, amount);
    }
    /*
     * RED WHEN the account stops receiving the receipt (the `receiveUnshielded` line
     * removed): nothing is owed, the transaction balances, and a payment is recorded
     * with no vault's payment behind it. Also RED WHEN it receives a token keyed on
     * anything but the paying vault's address, or more than one unit.
     */
    expect(owed.get(`unshielded:${receipt}`)).toBe(-1n);
    /* And nothing else in it is short: the one missing unit is the whole refusal. */
    expect([...owed].filter(([k, v]) => v !== 0n && k !== `unshielded:${receipt}`)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe('the roads a payment could be recorded on without a vault paying, each refused', () => {
  it('A CALL THROUGH noVault(): a governance proposal carrying a run payload pays nobody, even with noVault() adopted', async () => {
    /*
     * The route: a governance proposal names `noVault()`, and its payload can be
     * any 32 bytes, so a signer can raise one whose payload IS a run's. Once
     * approved, its id recomputes exactly as a run naming `noVault()` would. And
     * `adopt` refuses nothing about the vault it is handed, so here `noVault()`
     * has even been adopted, which leaves this step's own refusal as the only one.
     */
    const sim = await live();
    const noVault = pureCircuits.noVault();
    await sim.adoptVault(noVault, [A, B]);
    const payments = oneRun(2);
    const tree = payoutTreeOf(payments);
    const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n);
    const c = change(0n, 21);
    await sim.as(sim.applying(A, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);
    await sim.as(sim.applying(A, c)).approve(id);
    await sim.as(sim.applying(B, c)).approve(id);

    /* RED WHEN the step stops refusing `noVault()` as the run's vault. */
    await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(
      claim({ tree, id }, payments, noVault, c, 0)))
      .rejects.toThrow(/a governance proposal pays nobody/);
  });

  it('A CONTRACT THE ACCOUNT NEVER ADOPTED: a run naming it is approved, and the payment is still refused', async () => {
    /*
     * Anybody can deploy a contract that mints its own token, so a receipt proves
     * only that the named contract took part. A run approved while naming such a
     * contract, through a deceived approval screen say, must pay nobody.
     */
    const sim = await live();
    const payments = oneRun(3);
    const c = change(0n, 31);
    const run = await approvedRun(sim, STRANGER, payments, c);

    /* RED WHEN the step stops checking that the paying contract was ever adopted. */
    await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(
      claim(run, payments, STRANGER, c, 0)))
      .rejects.toThrow(/not a vault this company has adopted/);
    expect(sim.ledger.movements.size()).toBe(0n);
  });

  it('THE SEATED ROAD: one signer alone, at a threshold of one, raises and approves a run and still records nobody paid without a vault', async () => {
    const sim = await live([A], 1n);
    const payments = oneRun(4);
    const c = change(0n, 41);
    const run = await approvedRun(sim, STRANGER, payments, c, [A]);
    /* RED WHEN the step stops checking adoption: one signer would mark a person paid alone. */
    await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(
      claim(run, payments, STRANGER, c, 0)))
      .rejects.toThrow(/not a vault this company has adopted/);
    /* And the person's month is untouched, so a real payment can still be made. */
    expect(sim.ledger.movements.member(
      pureCircuits.paidOnceOf(fromHex(payments[0]!.nonce)))).toBe(false);
  });

  it('THE OLD STEP IS GONE: the account compiles no `recordPayment`, only the step that takes a receipt', () => {
    const circuits = Object.keys(new Contract(witnesses as any).impureCircuits);
    /* RED WHEN a `recordPayment` circuit is added back beside the new one. */
    expect(circuits).not.toContain('recordPayment');
    expect(circuits).toContain('recordPaymentFromVault');
    expect(readFileSync(CONTRACT_SOURCE, 'utf8')).not.toMatch(/circuit recordPayment\s*\(/);
  });
});

/* ------------------------------------------------------------------ */

describe('which vault may pay', () => {
  it('A RETIRED VAULT STILL PAYS: "ever adopted", never "adopted now"', async () => {
    /*
     * A funded vault can be dropped from `vaults` by a governed retire. If only a
     * vault adopted NOW could record a payment, that vault's money would be frozen
     * until it was adopted again.
     */
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const payments = oneRun(5);
    const c = change(0n, 51);
    const run = await approvedRun(sim, PAYROLL, payments, c);

    const rc = change(0n, 52);
    const retire = pureCircuits.retireVaultPayload(PAYROLL);
    await sim.as(sim.applying(A, rc)).propose(retire);
    const rid = sim.proposalId(retire, rc.salt);
    await sim.as(A).approve(rid);
    await sim.as(B).approve(rid);
    await sim.retireVault(rid, PAYROLL, rc.salt);
    expect(sim.adopted(PAYROLL)).toBe(false);

    /* RED WHEN the step accepts only a vault adopted now (`retiredAt` no longer read). */
    await sim.as(sim.applying(A, c)).recordPaymentFromVault(claim(run, payments, PAYROLL, c, 0));
    expect(sim.ledger.movements.member(
      pureCircuits.paidOnceOf(fromHex(payments[0]!.nonce)))).toBe(true);
  });

  it('A RUN IS PAID BY THE VAULT IT NAMES: another adopted vault cannot pay it with its own receipt', async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    await sim.adoptVault(TREASURY, [A, B], 393);
    const payments = oneRun(6);
    const c = change(0n, 61);
    const run = await approvedRun(sim, PAYROLL, payments, c);
    /* RED WHEN the step stops requiring the paying vault to be the run's vault. */
    await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(
      claim(run, payments, PAYROLL, c, 0, TREASURY)))
      .rejects.toThrow(/that run is for another vault/);
  });

  it("returns the account's own address, which the vault mints the receipt to", async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const payments = oneRun(7);
    const c = change(0n, 71);
    const run = await approvedRun(sim, PAYROLL, payments, c);
    const out: any = await sim.as(sim.applying(A, c)).recordPaymentFromVault(
      claim(run, payments, PAYROLL, c, 0));
    /* RED WHEN the step returns any address but its own. */
    expect(hex(out.bytes)).toBe(String(sim.address));
  });

  it("receives exactly one unit of the paying vault's receipt, and mints, claims and sends nothing", async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const payments = oneRun(8);
    const c = change(0n, 81);
    const run = await approvedRun(sim, PAYROLL, payments, c);
    await sim.as(sim.applying(A, c)).recordPaymentFromVault(claim(run, payments, PAYROLL, c, 0));
    const fx = sim.lastEffects;
    const L: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    const receipt = L.rawTokenType(pureCircuits.paymentReceiptTag(), hex(PAYROLL));
    /* RED WHEN the receipt's amount or its token changes. */
    expect(unshielded(fx.unshieldedInputs)).toEqual([[receipt, 1n]]);
    /* RED WHEN the step also mints, sends or claims anything. */
    expect([...fx.unshieldedMints]).toEqual([]);
    expect([...fx.shieldedMints]).toEqual([]);
    expect([...fx.unshieldedOutputs]).toEqual([]);
    expect([...fx.claimedUnshieldedSpends]).toEqual([]);
    expect([...fx.claimedShieldedReceives]).toEqual([]);
    expect([...fx.claimedShieldedSpends]).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe('a company-wide run: any vault ever adopted may pay its own leaf, never a stricter one', () => {
  /** A company-wide run whose one leaf is bound to `boundTo`. */
  const companyRun = async (sim: AccountSimulator, boundTo: Uint8Array, seed: number) => {
    const inner = bytes(seed);
    const payments: PayoutLeafInput[] = [{
      details: toHex(pureCircuits.companyWideDetailsOf(inner, boundTo)),
      nonce: toHex(bytes(seed + 100)),
    }];
    const c = change(0n, seed);
    const run = await approvedRun(sim, pureCircuits.companyWide(), payments, c);
    /* What the vault hands over is the inner details; the account binds them itself. */
    const args = {
      ...claim(run, payments, pureCircuits.companyWide(), c, 0, boundTo),
      details: inner,
    };
    return { args, c, payments };
  };

  const setBar = async (sim: AccountSimulator, vault: Uint8Array, to: bigint, seed: number) => {
    const tc = change(0n, seed);
    const bar = pureCircuits.setVaultThresholdPayload(vault, to);
    await sim.as(sim.applying(A, tc)).propose(bar);
    const bid = sim.proposalId(bar, tc.salt);
    await sim.as(A).approve(bid);
    await sim.as(B).approve(bid);
    await sim.as(sim.applying(A, tc)).setVaultThreshold(vault, to, bid);
  };

  it("pays a vault with no bar of its own, on the company's approvals, against that vault's receipt", async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const { args, c, payments } = await companyRun(sim, PAYROLL, 9);
    await sim.as(sim.applying(A, c)).recordPaymentFromVault(args);
    expect(sim.ledger.movements.member(
      pureCircuits.paidOnceOf(fromHex(payments[0]!.nonce)))).toBe(true);
    const L: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    const receipt = L.rawTokenType(pureCircuits.paymentReceiptTag(), hex(PAYROLL));
    /* RED WHEN the receipt is keyed on the run's vault instead of the paying vault. */
    expect(unshielded(sim.lastEffects.unshieldedInputs)).toEqual([[receipt, 1n]]);
  });

  it("A RETIRED VAULT STILL PAYS ITS OWN COMPANY-WIDE LEAF", async () => {
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const { args, c, payments } = await companyRun(sim, PAYROLL, 13);
    const rc = change(0n, 14);
    const retire = pureCircuits.retireVaultPayload(PAYROLL);
    await sim.as(sim.applying(A, rc)).propose(retire);
    const rid = sim.proposalId(retire, rc.salt);
    await sim.as(A).approve(rid);
    await sim.as(B).approve(rid);
    await sim.retireVault(rid, PAYROLL, rc.salt);
    expect(sim.adopted(PAYROLL)).toBe(false);
    /* RED WHEN "ever adopted" is read for anything but the paying vault on a company-wide run. */
    await sim.as(sim.applying(A, c)).recordPaymentFromVault(args);
    expect(sim.ledger.movements.member(
      pureCircuits.paidOnceOf(fromHex(payments[0]!.nonce)))).toBe(true);
  });

  it("THE STRICTER-VAULT REFUSAL: a vault whose own bar is above the company's is refused", async () => {
    const sim = await live([A, B, C], 2n);
    await sim.adoptVault(TREASURY, [A, B]);
    await setBar(sim, TREASURY, 3n, 94);
    const { args, c } = await companyRun(sim, TREASURY, 10);
    /* RED WHEN the step stops comparing the paying vault's own bar with the company's. */
    await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(args))
      .rejects.toThrow(/needs more approvals than the company's threshold/);
  });

  it("a vault whose own bar EQUALS the company's is not stricter, and is paid", async () => {
    const sim = await live([A, B, C], 2n);
    await sim.adoptVault(TREASURY, [A, B]);
    await setBar(sim, TREASURY, 2n, 95);
    const { args, c } = await companyRun(sim, TREASURY, 11);
    /* RED WHEN "stricter" becomes "at least as strict". */
    await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(args)).resolves.toBeDefined();
  });

  it('A LEAF NOT BOUND TO A VAULT PAYS NOBODY, so no vault can spend a leaf made for another', async () => {
    /*
     * The attack the binding closes: a company-wide run's leaf made from details that
     * name no vault. Without the account binding the leaf to the vault paying it,
     * ANY vault ever adopted could spend it - and a salt holder, a removed signer
     * among them, could spend every vault's leaf through whichever vault they liked.
     */
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    await sim.adoptVault(TREASURY, [A, B], 393);
    const payments = oneRun(12);
    const c = change(0n, 12);
    const run = await approvedRun(sim, pureCircuits.companyWide(), payments, c);
    for (const payer of [PAYROLL, TREASURY]) {
      /* RED WHEN the account stops binding a company-wide leaf to the vault paying it. */
      await expect(sim.as(sim.applying(A, c)).recordPaymentFromVault(
        claim(run, payments, pureCircuits.companyWide(), c, 0, payer)))
        .rejects.toThrow(/that payee is not in the approved run/);
    }
    expect(sim.ledger.movements.size()).toBe(0n);
  });
});

/* ------------------------------------------------------------------ */

describe("what the payment step publishes", () => {
  it("publishes the payee's leaf value and the person-month value, never the details or the nonce they are made from", async () => {
    const { Transcript } = await import('./transcript.js');
    const sim = await live();
    await sim.adoptVault(PAYROLL, [A, B]);
    const payments = oneRun(15);
    const c = change(0n, 15);
    const run = await approvedRun(sim, PAYROLL, payments, c);
    const tape = Transcript.watch(sim.contract).clear();
    await sim.as(sim.applying(A, c)).recordPaymentFromVault(claim(run, payments, PAYROLL, c, 0));
    const t = tape.last;
    tape.stop();
    t.assertNotVacuous();
    const leaf = pureCircuits.payoutLeaf(fromHex(payments[0]!.details), fromHex(payments[0]!.nonce));
    /* The positive control: what the step is meant to publish is found. */
    t.assertPublishes({
      'the leaf value': pureCircuits.paidMovementOf(leaf),
      'the person-month value': pureCircuits.paidOnceOf(fromHex(payments[0]!.nonce)),
      'the paying vault': PAYROLL,
    });
    /* RED WHEN the step discloses the details or the nonce themselves. */
    t.assertAbsent({
      "the payee's details": fromHex(payments[0]!.details),
      "the payee's nonce": fromHex(payments[0]!.nonce),
    });
  });
});

describe('the account moves no money of its own', () => {
  /*
   * The receipt is only worth anything while nobody else can hold the vault's token.
   * The vault mints it only inside its payment, straight to the account, and the
   * account must never send it on - or mint, claim or receive anything else.
   */
  const MONEY = /\b(receiveUnshielded|sendUnshielded|mintUnshieldedToken|receiveShielded|sendShielded|sendImmediateShielded|mintShieldedToken|mergeCoin|mergeCoinImmediate|createZswapInput|createZswapOutput|kernel\.(?:mint\w*|claim\w*|inc\w*))\b/g;

  it('only the two vault steps touch money, and each only to receive one receipt', () => {
    const src = readFileSync(CONTRACT_SOURCE, 'utf8');
    /* Every top-level block that runs: each circuit, and the constructor. */
    const starts = [...src.matchAll(/^(?:export )?(?:circuit (\w+)\s*\(|(constructor)\s*\()/gm)];
    const touched: Record<string, string[]> = {};
    starts.forEach((m, i) => {
      const body = src.slice(m.index!, starts[i + 1]?.index ?? src.length);
      const hits = [...body.matchAll(MONEY)].map((h) => h[1]!);
      if (hits.length) touched[(m[1] ?? m[2])!] = hits;
    });
    /* RED WHEN any circuit, or the constructor, gains a line that moves money. The two payment
       steps, one payee and a batch, receive their receipt in the checks they share. */
    expect(touched).toEqual({
      requirePayable: ['receiveUnshielded'], approveVaultChange: ['receiveUnshielded'],
    });
    /* The scan saw every circuit and the constructor, not a truncated file. */
    expect(starts.length).toBeGreaterThan(40);
    /* RED WHEN any circuit but the two payment steps reaches the shared checks, and with them the receive. */
    const callers = starts.filter((m, i) => /\brequirePayable\(/.test(src.slice(m.index!, starts[i + 1]?.index ?? src.length))
      && m[1] !== 'requirePayable').map((m) => m[1]);
    expect(callers.sort()).toEqual(['recordBatchFromVault', 'recordPaymentFromVault']);
  });

  it('and the compiled contract agrees: one receive helper, called once by each', () => {
    const js = readFileSync(join(import.meta.dirname, '..', 'managed', 'contract', 'index.js'), 'utf8');
    /* RED WHEN the compiled contract gains a send, a mint or a second receive. */
    expect(js.match(/this\._(receiveUnshielded|sendUnshielded|mintUnshieldedToken|receiveShielded|sendShielded|mintShieldedToken)_\d+\(/g))
      .toEqual(['this._receiveUnshielded_0(', 'this._receiveUnshielded_0(']);
  });
});
