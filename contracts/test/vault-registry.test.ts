/**
 * WHICH VAULTS ARE THIS COMPANY'S, AND WHEN ONE STOPS BEING.
 *
 * The gap this closes is a recovery gap rather than a security one, and the
 * distinction is the reason the tests below assert what they do.
 *
 * Anyone may deploy a vault naming anyone's account — nothing consents to a
 * deployment. **That is not a theft hole:** to spend, a proposal must exist
 * whose id was computed with that vault inside it, and only a seated signer can
 * raise one. What a stranger's vault can do is exist, and be paid into. Every
 * vault that has ever PAID is already on chain by name, because `payout`
 * discloses `kernel.self().bytes` to `recordPaymentFromVault`. So the chain records
 * every vault except the one that most needs recording: one that has been
 * funded and has never paid.
 *
 * Two circuits, and they are deliberately not symmetrical:
 *
 *   `adopt`        the account's alone. Nothing is asked of the vault, because
 *                  a vault that does not exist yet must not be able to stop a
 *                  company writing down what it intends to fund.
 *   `retire`       raised at the VAULT, because the vault must mark itself
 *                  retired, so it takes no more money, and only the vault can
 *                  write its own state. It then calls the account, which owns
 *                  the rule, and mints it the receipt the account's half needs,
 *                  so no retirement reaches the account without the mark.
 *                  Retiring never needs the vault empty.
 *
 * The one to read last, and the one a future reader is most likely to try to
 * "fix": **a retired vault can still pay.** Nothing consults `vaults` on the
 * spend path, on purpose.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createConstructorContext, createCircuitContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  Contract as Vault,
  ledger as vaultLedger,
  pureCircuits as vaultCircuits
} from '../managed-vault/contract/index.js';
import { pureCircuits, ledger as accountLedger } from '../managed/contract/index.js';
import { AccountSimulator, privateStateFor, change, type Change, payoutTreeOf, vaultRunOf } from './simulator.js';
import { carryTheAccount, startTheVault, TEST_VAULT_SECRET } from './start-a-vault.js';
import { type PayoutLeafInput } from '../../src/midnight/payout-tree.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { adoptionRoundOf, type AccountStartPure } from '../../src/midnight/vault-start.js';
import { noFurtherNote } from '../../src/midnight/vault-step-notes.js';
import { ACCOUNT_KEYS, keysOnDisk } from './keys-on-disk.js';

/* A vault's call into its account binds to the account's verifier keys, read from this build's own keys folder. */
const ACCOUNT_KEYS_ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

const VAULT_NOW = 1_800_000_000;
const WIN_FROM = BigInt(VAULT_NOW - 3_600);
const WIN_UNTIL = BigInt(VAULT_NOW + 3_600);
const BLOCK = '0'.repeat(64);

const bytes = (n: number) => new Uint8Array(32).fill(n);

const A = privateStateFor(1);
const B = privateStateFor(2);
const C = privateStateFor(3);
const TOKEN_BYTES = bytes(0x9b);
const ALICE = bytes(0x0a);

/** A vault address that is not a deployed vault. The account never dereferences one. */
const STRANGER = bytes(0xf1);

interface VaultPrivate {
  coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mt_index: bigint };
}

const vaultWitnesses = {
  noteToSpend: (ctx: { privateState: VaultPrivate }) => [ctx.privateState, ctx.privateState.coin],
  nonceSecret: (ctx: { privateState: { secret?: Uint8Array } }) => [
    ctx.privateState,
    ctx.privateState.secret ?? TEST_VAULT_SECRET
  ]
};

const govChange = (seed: number): Change => change(0n, seed);
const carrying = (sim: AccountSimulator, d: ReturnType<typeof privateStateFor>, c: Change) => sim.applying(d, c);

describe.skipIf(!ACCOUNT_KEYS_ON_DISK)(
  'an account keeps a register of its own vaults [needs contracts/managed/keys; `npm run compact` builds them]',
  () => {
    let sim: AccountSimulator;
    let vault: Vault<VaultPrivate>;
    let vaultAddr: string;
    let vaultState: any;
    let priv: VaultPrivate;

    const vaultBytes = () => Uint8Array.from(Buffer.from(vaultAddr, 'hex'));
    const ctx = (circuit: string) =>
      createCircuitContext<VaultPrivate>({
        circuitId: circuit,
        contractAddress: vaultAddr as never,
        coinPublicKeyOrZswapState: BLOCK,
        contractState: vaultState,
        privateState: priv,
        crossContract: sim.crossContract(),
        time: VAULT_NOW,
        parentBlockHash: BLOCK
      });

    beforeEach(async () => {
      sim = await AccountSimulator.liveAccount([A, B], 2n);
      sim.at(VAULT_NOW);

      vault = new Vault<VaultPrivate>(vaultWitnesses as never);
      vaultAddr = sampleContractAddress() as never as string;
      priv = { coin: { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n, mt_index: 0n } };
      const init = await vault.initialState(createConstructorContext({} as VaultPrivate, BLOCK), {
        bytes: Uint8Array.from(Buffer.from(String(sim.address), 'hex'))
      } as never);
      vaultState = init.currentContractState;
    });

    /** Raises an adoption round for `v` and takes it to the account's threshold. */
    const adoptionRound = async (v: Uint8Array, c: Change) => {
      const payload = pureCircuits.adoptVaultPayload(v);
      await sim.as(carrying(sim, A, c)).propose(payload);
      const id = sim.proposalId(payload, c.salt);
      await sim.as(carrying(sim, B, c)).approve(id);
      return id;
    };

    /** The same, for a retirement. */
    const retirementRound = async (v: Uint8Array, c: Change) => {
      const payload = pureCircuits.retireVaultPayload(v);
      await sim.as(carrying(sim, A, c)).propose(payload);
      const id = sim.proposalId(payload, c.salt);
      await sim.as(carrying(sim, B, c)).approve(id);
      return id;
    };

    /** Puts one note in the vault, so a retirement has something to refuse over. */
    const fund = async () => {
      const coin = { nonce: bytes(0x77), color: TOKEN_BYTES, value: 1_000n };
      const dep = await vault.impureCircuits.deposit(ctx('deposit'), coin);
      vaultState = dep.context.callContext.currentQueryContext.state;
    };

    /** Retires through the vault, which is the only route there is. */
    const retire = async (id: Uint8Array, c: Change) => {
      const r = await vault.impureCircuits.retire(ctx('retire'), id, c.salt);
      vaultState = r.context.callContext.currentQueryContext.state;
      sim.adoptFromCall(r.context);
      return r;
    };

    it("ADOPTS a vault through a round at the account's own threshold", async () => {
      const c = govChange(81);
      expect(sim.adopted(vaultBytes())).toBe(false);

      const id = await adoptionRound(vaultBytes(), c);
      await sim.as(carrying(sim, A, c)).adopt(vaultBytes(), id);

      expect(sim.adopted(vaultBytes())).toBe(true);
      /* And the proposal is spent, exactly as every other governance proposal is. */
      expect(sim.isOpen(id)).toBe(false);
    });

    it('publishes HOW MANY vaults a company runs, which is the decided cost', async () => {
      /*
       * How many vaults a company runs is public by design. Asserted here so
       * that a later change which quietly made the set private would fail a
       * test rather than a review.
       */
      const c1 = govChange(82);
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
      const c2 = govChange(83);
      await sim.as(carrying(sim, A, c2)).adopt(STRANGER, await adoptionRound(STRANGER, c2));

      expect(sim.ledger.vaults.size()).toBe(2n);
    });

    it('refuses an adoption from somebody who is not a signer', async () => {
      const c = govChange(84);
      const id = await adoptionRound(vaultBytes(), c);
      /* RED WHEN somebody not seated can adopt: their device offers a path for its own leaf beside a signer's
       * siblings, so the witness answers and the circuit refuses. */
      const offering = sim.dishonest(carrying(sim, C, c), { ...sim.pathFor(A), leaf: sim.leafOf(C) });
      await expect(sim.as(offering).adopt(vaultBytes(), id)).rejects.toThrow(
        /(?<!you are )not a signer on this account/
      );
      expect(sim.adopted(vaultBytes())).toBe(false);
    });

    it('refuses an adoption before the account threshold is met', async () => {
      const c = govChange(85);
      const payload = pureCircuits.adoptVaultPayload(vaultBytes());
      await sim.as(carrying(sim, A, c)).propose(payload);
      const id = sim.proposalId(payload, c.salt);
      /* A's raise counted A: one approval of two. */

      await expect(sim.as(carrying(sim, A, c)).adopt(vaultBytes(), id)).rejects.toThrow(/not enough approvals yet/i);
      expect(sim.adopted(vaultBytes())).toBe(false);
    });

    it('REFUSES TO ADOPT A VAULT THE PROPOSAL DID NOT NAME', async () => {
      /*
       * The attack this exists for: a round the signers approved for the
       * company's own vault, replayed against an address they never saw. The
       * vault is inside the payload, so the id simply does not recompute.
       */
      const c = govChange(86);
      const id = await adoptionRound(vaultBytes(), c);

      await expect(sim.as(carrying(sim, A, c)).adopt(STRANGER, id)).rejects.toThrow(
        /does not authorise adopting this vault/i
      );
      expect(sim.adopted(STRANGER)).toBe(false);
    });

    it('refuses to adopt the same vault twice rather than spending the proposal silently', async () => {
      const c1 = govChange(87);
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));

      const c2 = govChange(88);
      const id2 = await adoptionRound(vaultBytes(), c2);
      await expect(sim.as(carrying(sim, A, c2)).adopt(vaultBytes(), id2)).rejects.toThrow(
        /already adopted that vault/i
      );
    });

    it('an approval to adopt is not an approval to retire, or to change a threshold', async () => {
      /*
       * Domain separation, played rather than asserted about. The payload for
       * adopting a vault and the payload for setting its threshold are different
       * bytes, so a round raised for one is not a round for the other.
       */
      const v = vaultBytes();
      expect(toHex(pureCircuits.adoptVaultPayload(v))).not.toBe(toHex(pureCircuits.retireVaultPayload(v)));
      expect(toHex(pureCircuits.adoptVaultPayload(v))).not.toBe(toHex(pureCircuits.setVaultThresholdPayload(v, 2n)));

      const c = govChange(89);
      const id = await adoptionRound(v, c);
      await expect(sim.as(carrying(sim, A, c)).setVaultThreshold(v, 3n, id)).rejects.toThrow(
        /does not authorise this vault threshold/i
      );
    });

    it("RETIRES an empty vault, and the proposal is the account's to approve", async () => {
      const c1 = govChange(90);
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
      expect(sim.adopted(vaultBytes())).toBe(true);

      const c2 = govChange(91);
      const id = await retirementRound(vaultBytes(), c2);
      await retire(id, c2);

      expect(sim.adopted(vaultBytes())).toBe(false);
      expect(sim.isOpen(id)).toBe(false);

      /*
       * AND THE RETIREMENT IS RECORDED.
       *
       * The account keeps its own log of what it retired, because the company
       * that needs it is one whose device, database and supplier have all gone —
       * the same recovery argument that put `vaults` on chain rather than in our
       * records.
       *
       * MEMBERSHIP AND NOT A DATE, DELIBERATELY. No circuit can read the block
       * time (`blockTimeGte`/`blockTimeLt` are predicates and there is no
       * `kernel.blockTime()`), and a time taken as an argument would be the
       * caller's word for it — here, a VAULT's. So the value is a marker and the
       * date lives in the block that carries the write. The field is `Uint<64>`
       * so a real time can be written by a later circuit; the TYPE is the half
       * that can never be changed.
       */
      expect(sim.ledger.retiredAt.member(vaultBytes())).toBe(true);
    });

    it('RETIREMENT IS HALF BUILT: the retirement is logged and the STALE THRESHOLD SURVIVES', async () => {
      /*
       * WRITTEN AS AN ASSERTION RATHER THAN A SENTENCE IN A DOCUMENT, because
       * retiring a vault has two halves and only one of them is built.
       *
       * `setVaultThreshold` inserts into `thresholds` and NOTHING ANYWHERE
       * REMOVES. So a retired vault keeps its own governing
       * threshold — a number for an address the account has just declared it no
       * longer runs, which `thresholdFor` would hand straight back to
       * `requireApprovedForVault` if that address were ever adopted again.
       *
       * THIS TEST GOES RED THE DAY SOMEBODY CLOSES IT, which is the point: the
       * gap stops being something a reader has to be told and becomes something
       * the suite states. Whoever closes it changes this test in the same round.
       */
      const c1 = govChange(94);
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));

      // Give it a threshold of its own, through its own approved round.
      const c2 = govChange(95);
      const payload = pureCircuits.setVaultThresholdPayload(vaultBytes(), 2n);
      await sim.as(carrying(sim, A, c2)).propose(payload);
      const tid = sim.proposalId(payload, c2.salt);
      await sim.as(carrying(sim, B, c2)).approve(tid);
      await sim.as(carrying(sim, A, c2)).setVaultThreshold(vaultBytes(), 2n, tid);
      expect(sim.ledger.thresholds.member(vaultBytes())).toBe(true);

      const c3 = govChange(96);
      await retire(await retirementRound(vaultBytes(), c3), c3);

      // The half that is built.
      expect(sim.adopted(vaultBytes())).toBe(false);
      expect(sim.ledger.retiredAt.member(vaultBytes())).toBe(true);

      // The half it did not. Not a passing assertion dressed as coverage — this
      // is the defect, stated.
      expect(sim.ledger.thresholds.member(vaultBytes())).toBe(true);
    });

    /** A vault takes no money until the account has adopted it and approved its first secret. */
    const startHere = () =>
      startTheVault({
        sim,
        vault: Uint8Array.from(Buffer.from(String(vaultAddr), 'hex')),
        approvers: [A, B],
        now: VAULT_NOW,
        call: async (circuit, ...a) => {
          const r: any = await (vault.impureCircuits as any)[circuit](
            createCircuitContext({
              circuitId: circuit as never,
              contractAddress: vaultAddr as never,
              coinPublicKeyOrZswapState: BLOCK,
              contractState: vaultState,
              privateState: {} as never,
              crossContract: sim.crossContract(),
              time: VAULT_NOW,
              parentBlockHash: BLOCK
            }),
            ...a
          );
          vaultState = r.context.callContext.currentQueryContext.state;
          carryTheAccount(sim, r.context);
        }
      });

    it('THE ONE THAT MATTERS: a vault still holding notes is retired, keeps them, and takes no more', async () => {
      /*
       * Retiring never needs the vault empty, so nobody outside the company can
       * block a retirement by paying a vault something. What it holds stays
       * payable through the account (below). What the vault refuses from its
       * retirement on is new money, and the refusal is the VAULT's: it marks
       * itself retired before it asks the account, so no retired vault is left
       * taking deposits whatever the account says of it later.
       */
      const c1 = govChange(92);
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
      await startHere();
      await fund();
      expect(vaultLedger(vaultState as never).notes.size()).toBe(1n);

      const c2 = govChange(93);
      const id = await retirementRound(vaultBytes(), c2);
      /* RED WHEN retiring refuses a vault that holds money. */
      await retire(id, c2);
      expect(sim.adopted(vaultBytes())).toBe(false);
      expect(sim.isOpen(id)).toBe(false);
      /* RED WHEN retiring takes or drops what the vault holds. */
      expect(vaultLedger(vaultState as never).notes.size()).toBe(1n);
      /* RED WHEN the vault stops marking itself, or stops refusing money once marked. */
      expect(vaultLedger(vaultState as never).retired).toBe(true);
      await expect(fund()).rejects.toThrow(/has been retired, so it takes no more money/);
    });

    it('refuses to retire a vault this account never adopted', async () => {
      const c = govChange(94);
      const id = await retirementRound(vaultBytes(), c);
      await expect(retire(id, c)).rejects.toThrow(/has not adopted that vault/i);
    });

    it("refuses a retirement claimed without the proposal's salt", async () => {
      /*
       * The salt is the proof of possession that stands in for `requireSigner`,
       * which a cross-contract callee cannot use: a contract holds no secret key
       * and sits in no signer tree. Without the right salt the id does not
       * recompute.
       */
      const c = govChange(95);
      await sim.as(carrying(sim, A, c)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c));
      const c2 = govChange(96);
      const id = await retirementRound(vaultBytes(), c2);

      await expect(vault.impureCircuits.retire(ctx('retire'), id, bytes(0xee))).rejects.toThrow(
        /does not authorise retiring this vault/i
      );
    });

    it('refuses a retirement that has not reached the account threshold', async () => {
      const c = govChange(97);
      await sim.as(carrying(sim, A, c)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c));

      const c2 = govChange(98);
      const payload = pureCircuits.retireVaultPayload(vaultBytes());
      await sim.as(carrying(sim, A, c2)).propose(payload);
      const id = sim.proposalId(payload, c2.salt);
      /* A's raise counted A: one approval of two. */

      await expect(retire(id, c2)).rejects.toThrow(/not enough approvals yet/i);
      expect(sim.adopted(vaultBytes())).toBe(true);
    });

    it('A RETIRED VAULT CAN STILL PAY, and that is the decision rather than an oversight', async () => {
      /*
       * Nothing on the spend path consults `vaults`, deliberately. The list
       * answers "which vaults are this company's" for somebody who has lost
       * everything else; making it an access check would turn a governance
       * mistake — a round raised against the wrong address, a vault retired in
       * error — into money that cannot be moved. Retirement means the product
       * stops OFFERING the vault, and nothing more.
       *
       * The account's payment step takes a vault it adopted now or before it was
       * retired. If a later change narrows that to the vaults it holds today, this
       * test is the one that will say so.
       */
      const c1 = govChange(99);
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
      /* Started and funded while it is the company's: a retired vault can be given no secret and takes no money. */
      await startHere();
      await fund();
      const c2 = govChange(100);
      await retire(await retirementRound(vaultBytes(), c2), c2);
      expect(sim.adopted(vaultBytes())).toBe(false);

      /* Now pay somebody out of it. */
      const c3 = govChange(101);
      const leaves: PayoutLeafInput[] = [
        {
          details: toHex(vaultCircuits.payoutDetails(ALICE, TOKEN_BYTES, 250n, bytes(0x40))),
          nonce: toHex(bytes(0xc1))
        }
      ];
      const tree = payoutTreeOf(leaves, [250n], TOKEN_BYTES);
      const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, 0n);
      await sim.as(carrying(sim, A, c3)).proposeRun({
        root: fromHex(tree.root),
        payees: tree.payees,
        from: WIN_FROM,
        until: WIN_UNTIL,
        vault: vaultBytes()
      });
      const id = sim.proposalId(payload, c3.salt, vaultBytes());
      await sim.as(carrying(sim, B, c3)).approve(id);

      /* RED WHEN the account's payment step refuses a vault it has retired. */
      const paid = await vault.impureCircuits.payout(
        ctx('payout'),
        vaultRunOf({
          proposal: id,
          vault: vaultBytes(),
          tree,
          i: 0,
          opensAt: WIN_FROM,
          closesAt: WIN_UNTIL,
          salt: c3.salt,
          nonce: bytes(0xc1)
        }),
        ALICE,
        TOKEN_BYTES,
        250n,
        bytes(0x40),
        noFurtherNote()
      );

      expect(vaultLedger(paid.context.callContext.currentQueryContext.state as never).payments).toBe(1n);
      /* And the account recorded it. */
      expect(
        accountLedger((paid.context as any).queryContexts[sim.address as never].state).movements.member(
          pureCircuits.paidOnceOf(bytes(0xc1))
        )
      ).toBe(true);
    });
    it("A RETIRED VAULT STILL HOLDING MONEY IS ADOPTED AGAIN AT THE COMPANY'S THRESHOLD AND PAID OUT OF, AND TAKES NO MORE", async () => {
      const P = pureCircuits as unknown as AccountStartPure;
      const first = adoptionRoundOf(P, vaultAddr);
      const c1 = { ...govChange(110), salt: fromHex(first.salt) };
      await sim.as(carrying(sim, A, c1)).adopt(vaultBytes(), await adoptionRound(vaultBytes(), c1));
      await startHere();
      /* Money paid in before the retire, which retiring leaves where it is. */
      await fund();
      const c2 = govChange(111);
      const retiredBy = await retirementRound(vaultBytes(), c2);
      await retire(retiredBy, c2);

      /* The first adoption made again is the same proposal, and the account remembers both seats approved it once. */
      await sim.as(carrying(sim, A, c1)).propose(pureCircuits.adoptVaultPayload(vaultBytes()));
      await expect(sim.as(carrying(sim, B, c1)).approve(fromHex(first.proposal))).rejects.toThrow(/already approved/u);
      await sim.as(carrying(sim, A, c1)).cancel(fromHex(first.proposal));

      const again = adoptionRoundOf(P, vaultAddr, toHex(retiredBy));
      const c3 = { ...govChange(112), salt: fromHex(again.salt) };
      const id = await adoptionRound(vaultBytes(), c3);
      /* RED WHEN: a retired vault's adoption made again is the first one, which can never gather its approvals, so its money is stuck. */
      expect(toHex(id)).toBe(again.proposal);
      await sim.as(carrying(sim, A, c3)).adopt(vaultBytes(), id);
      expect(sim.adopted(vaultBytes())).toBe(true);
      /* RED WHEN adopting it again opens it to money: its mark stays. */
      await expect(fund()).rejects.toThrow(/has been retired, so it takes no more money/);

      const c4 = govChange(113);
      const leaves: PayoutLeafInput[] = [
        {
          details: toHex(vaultCircuits.payoutDetails(ALICE, TOKEN_BYTES, 250n, bytes(0x40))),
          nonce: toHex(bytes(0xc2))
        }
      ];
      const tree = payoutTreeOf(leaves, [250n], TOKEN_BYTES);
      const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, WIN_FROM, WIN_UNTIL, 0n);
      await sim.as(carrying(sim, A, c4)).proposeRun({
        root: fromHex(tree.root),
        payees: tree.payees,
        from: WIN_FROM,
        until: WIN_UNTIL,
        vault: vaultBytes()
      });
      const run = sim.proposalId(payload, c4.salt, vaultBytes());
      await sim.as(carrying(sim, B, c4)).approve(run);
      const paid = await vault.impureCircuits.payout(
        ctx('payout'),
        vaultRunOf({
          proposal: run,
          vault: vaultBytes(),
          tree,
          i: 0,
          opensAt: WIN_FROM,
          closesAt: WIN_UNTIL,
          salt: c4.salt,
          nonce: bytes(0xc2)
        }),
        ALICE,
        TOKEN_BYTES,
        250n,
        bytes(0x40),
        noFurtherNote()
      );
      /* RED WHEN: the money left in the retired vault cannot be paid out once the vault is adopted again. */
      expect(vaultLedger(paid.context.callContext.currentQueryContext.state as never).payments).toBe(1n);
    });
  }
);
