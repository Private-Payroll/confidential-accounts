/**
 * What a company's account contract holds on the chain, read through the indexer, and the checks a step must
 * pass against it before anything is built: the proposal is open, it has its approvals, the seat bar is met, the
 * signer leaf is usable, the account is deployed. Every answer is read from the chain at the time it is asked;
 * nothing here is kept between calls. The service's own wiring (its configuration, the fee payer, the sealed
 * store and the providers) is held here and used by the steps and the ledger built on it.
 */
import { contractStateAt } from './contract-state-at.js';
import type { Hex } from '../core/crypto.js';
import { toHex, fromHex } from '../core/crypto.js';
import { payKeyCommitmentIn } from './pay-key-round.js';
import type { RetryOptions } from './retry.js';
import type { MaintenanceAuthorityChoice } from './partial-contract.js';
import type { MidnightConfig, FeeSponsor, SealedStateStore } from './ledger.js';
import { UndecodedLedgerField, mapField, setSize, ADOPTED_SET, type CountedMap } from './contract-state-fields.js';
import { seatBarParts } from './already-paid.js';

/* ------------------------------------------------------------------ *
 * ledger
 * ------------------------------------------------------------------ */

/**
 * A 32-byte zero, for an argument a circuit takes and does not read.
 *
 * A circuit's arity is fixed, so something has to be passed. Zero is the honest
 * filler: it is a value `persistentCommit` can never produce, so it cannot
 * collide with a real proposal id, and the branch that would read it is not
 * taken.
 */
export const ZERO_32: Hex = '00'.repeat(32);

export class AccountReads {
  constructor(
    protected cfg: MidnightConfig,
    protected sponsor: FeeSponsor,
    protected blobs: SealedStateStore,
    /** Resolves an account id to its deployed contract address. */
    protected addressOf: (accountId: string) => Promise<string | null>,
    /** Built once by midnightProviders(). Lazy so construction needs no node. */
    protected providers: () => Promise<any>,
    /** The CompiledContract, from CompiledContract.make + withWitnesses. */
    protected compiled: unknown,
    /**
     * Deployment, which needs things the rest of the interface deliberately
     * refuses to carry. Optional: a client that only calls an existing account
     * has no business holding either.
     */
    protected deployment?: {
      /*
       * There is no deployer injection point here, so no secret can reach
       * this class at deploy: the constructor takes the founding signer's
       * leaf, a public value, and `AccountOpening` already carries it.
       */
      /**
       * Where a new account's address is recorded, so `addressOf` can find it
       * on the next call. A script writes a file; a service writes a row.
       */
      register: (accountId: string, address: string) => Promise<void>;
      /**
       * **SET ON A DEPLOYMENT WHOSE COMPANIES ARE MADE ON THEIR FOUNDING
       * SIGNER'S DEVICE, WHICH IS EVERY ONE ON A CHAIN.** The state a
       * company's first view opens with is then the company's state record,
       * as that device sealed and signed it, and the device deploys the account, held by
       * their own committee key from its first transaction, through the
       * service's creation route. Opening an account here is refused by name
       * either way.
       */
      fromTheFoundingSigner?: true;
      /**
       * The maintenance authority a deploy made by this process would give the
       * account. Read only by `deployFromThisProcess`, which nothing calls: a
       * company on a chain is created from its founding signer's browser.
       */
      maintenanceAuthority?: MaintenanceAuthorityChoice;
      /** Passed through so a script keeps its own logging. */
      retry?: RetryOptions;
    },
  ) {}

  /** The account's `movements` set, decoded, or null when it is not on this ledger. */
  protected async movementsOf(accountId: string): Promise<{ member(v: Uint8Array): boolean } | null> {
    const address = await this.addressOf(accountId);
    if (!address) return null;
    const { ledger: readLedger } = await import('../../contracts/managed/contract/index.js');
    const providers = await this.providers();
    const state = await contractStateAt(providers.publicDataProvider, address);
    if (!state) return null;
    const movements = (readLedger(state.data) as any)?.movements;
    if (movements == null || typeof movements.member !== 'function') {
      throw new UndecodedLedgerField('movements', 'set');
    }
    return movements;
  }

  protected async payKeyCommitmentAt(address: string): Promise<Hex | null> {
    const read = await this.signerRolesAt(address);
    if (read === null) throw new Error('the contract has no state on chain');
    return payKeyCommitmentIn(read.pureCircuits, read.roles);
  }

  /** The account's `signerRoles` map as the indexer holds it now, with the functions that read it, or null with no state. */
  protected async signerRolesAt(address: string): Promise<{ roles: any; pureCircuits: any } | null> {
    const { ledger: readLedger, pureCircuits } = await import('../../contracts/managed/contract/index.js');
    const providers = await this.providers();
    const state = await contractStateAt(providers.publicDataProvider, address);
    if (!state) return null;
    const roles = (readLedger(state.data) as any)?.signerRoles;
    if (roles == null || typeof roles.member !== 'function') {
      throw new UndecodedLedgerField('signerRoles', 'map');
    }
    return { roles, pureCircuits };
  }

  /**
   * A signer leaf the contract will not seat, refused before a fee is paid.
   *
   * The contract's constructor refuses a founding leaf that is
   * `default<Bytes<32>>` or `vacantSlot()`, and `reseatSigner` and
   * `seatInvited` refuse the same two for a leaf being seated, all with
   * the message "that is not a usable signer leaf". Without this mirror
   * the refusal would arrive from the chain: for the founding leaf, after
   * a deploy and a fee, and an unusable founding seat is permanently
   * fatal (every later seat needs an invitation an existing signer
   * raised, so nobody can ever seat the first).
   *
   * One helper, not two checks: the two contract asserts are the same
   * rule, a leaf must be a value the tree can hold and can tell apart
   * from an empty slot, read at two entry points. Writing it twice is how
   * the copies drift.
   *
   * The vacancy marker is read from the compiled artifact, never
   * restated: `pureCircuits.vacantSlot()` is the contract's own
   * definition, and a TypeScript constant for it would be a second
   * definition of a value the chain compares against.
   */
  protected async refuseUnusableLeaf(leaf: Hex, what: string): Promise<void> {
    if (leaf === ZERO_32) {
      throw new Error(
        `${what} is thirty-two zero bytes. Supply a signer leaf that is neither thirty-two `
        + 'zero bytes nor the vacancy marker. The contract refuses this value — it answers '
        + '"that is not a usable signer leaf", in its constructor for a founding leaf and in '
        + '`reseatSigner` for a leaf being seated — because thirty-two zero bytes is what an '
        + 'empty slot reads as, so a seat holding it is a seat nothing can ever prove.');
    }
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    if (leaf === toHex(pureCircuits.vacantSlot())) {
      throw new Error(
        `${what} is the vacancy marker itself. Supply a signer leaf that is neither `
        + 'thirty-two zero bytes nor the vacancy marker. The contract refuses this value — it '
        + 'answers "that is not a usable signer leaf", in its constructor for a founding leaf '
        + 'and in `reseatSigner` for a leaf being seated — because the tree uses the marker to '
        + 'mean THIS SLOT IS EMPTY, so seating it makes a slot that is simultaneously taken '
        + 'and free.');
    }
  }

  /**
   * Is this proposal open on chain?
   *
   * BY ID, because there is no longer a single "the" open proposal, and BY
   * PRESENCE, because the contract deletes a proposal when it settles or is
   * cancelled rather than zeroing a flag beside it. Presence is therefore the
   * whole answer, where the old shape had to read a boolean and a commitment
   * and hope they agreed.
   */
  protected async requireOpen(
    address: string, proposalId: Hex, what: string,
  ): Promise<{ approvals: number; threshold: number }> {
    const before = await this.readContractState(address);
    if (!before) throw new Error('the contract has no state on chain');
    const open = before.openProposals.find(p => p.id === proposalId);
    if (!open) {
      throw new Error(
        `cannot ${what}: there is no open proposal ${proposalId.slice(0, 12)} on this account. ` +
          'It has either settled, been cancelled, or was never raised here.',
      );
    }
    return { approvals: open.approvals, threshold: Number(before.threshold) };
  }

  /**
   * Open and past the threshold.
   *
   * One copy, because all four circuits that spend an approved proposal
   * need exactly this, and four copies of a rule with one of them missing
   * a line is how the copies drift.
   */
  protected async requireApproved(address: string, proposalId: Hex, what: string): Promise<void> {
    const { approvals, threshold } = await this.requireOpen(address, proposalId, what);
    /* The circuit's own reading: the proposal's bar when it was raised, and no signer removed
     * or re-seated since, before the higher of that bar and the threshold today. */
    const gov = await this.readGovernance(address);
    const hold = gov.holdOf(proposalId);
    if (!hold) {
      throw new Error(
        `cannot ${what}: that proposal has no record of the approvals it needs, so it can never be ` +
          'carried out. Raise it again.',
      );
    }
    if (hold.removals !== gov.removalsSoFar) {
      throw new Error(
        `cannot ${what}: ${gov.removalsSoFar - hold.removals} signer removal(s) or re-seat(s) since ` +
          'this was raised, and the contract refuses it for that. Raise it again.',
      );
    }
    const needed = hold.needed > BigInt(threshold) ? hold.needed : BigInt(threshold);
    if (BigInt(approvals) < needed) {
      throw new Error(
        `cannot ${what}: that proposal has ${approvals} of ${needed} approvals. ` +
          'The contract would reject it.',
      );
    }
  }

  /**
   * What the governance circuits read besides the counts: whether some bytes are a vault the
   * company holds (adopted and not retired), a proposal's bar and removal count when it was
   * raised, and the removal count now. Each through a guard, as every other read here.
   */
  protected async readGovernance(address: string): Promise<{
    holdsVault(vault: Hex): boolean;
    holdOf(proposalId: Hex): { needed: bigint; removals: bigint } | undefined;
    removalsSoFar: bigint;
  }> {
    const { ledger: readLedger, pureCircuits } = await import('../../contracts/managed/contract/index.js');
    const providers = await this.providers();
    const state = await contractStateAt(providers.publicDataProvider, address);
    if (!state) throw new Error('the contract has no state on chain');
    const parsed: any = readLedger(state.data);
    /* The contract's own set of adopted vault addresses, read by address. It is not the device's
     * record of vaults by name, which only `vault-record.ts` reads. */
    const adopted = parsed?.[ADOPTED_SET];
    if (adopted == null || typeof adopted.member !== 'function') throw new UndecodedLedgerField(ADOPTED_SET, 'set');
    const holds = parsed?.proposalHolds;
    if (holds == null || typeof holds.member !== 'function' || typeof holds.lookup !== 'function') {
      throw new UndecodedLedgerField('proposalHolds', 'map');
    }
    const countKey = pureCircuits.removalCountKey();
    if (!holds.member(countKey)) throw new UndecodedLedgerField('proposalHolds', 'map');
    return {
      holdsVault: (vault) => Boolean(adopted.member(fromHex(vault))),
      holdOf: (id) => {
        const key = fromHex(id);
        if (!holds.member(key)) return undefined;
        const h = holds.lookup(key);
        return { needed: BigInt(h.needed), removals: BigInt(h.removals) };
      },
      removalsSoFar: BigInt(holds.lookup(countKey).removals),
    };
  }

  /**
   * Open AND at the higher of the threshold and the approvals a policy change
   * needs: the number the circuits that change who is seated, and those that
   * change a policy or that number, ask for. A device that compared with the
   * threshold alone would let through, and charge a fee for, a call the chain
   * then refuses.
   */
  protected async requireSeatBar(address: string, proposalId: Hex, what: string): Promise<void> {
    /* The circuits ask `requireApproved`'s questions first: the bar when raised, no removal since. */
    await this.requireApproved(address, proposalId, what);
    const { approvals } = await this.requireOpen(address, proposalId, what);
    const now = await this.readContractState(address);
    if (!now) throw new Error('the contract has no state on chain');
    const { bar, policyBar } = seatBarParts(now);
    if (BigInt(approvals) < bar) {
      throw new Error(
        `cannot ${what}: that proposal has ${approvals} of ${bar} approvals. ` +
          `It needs as many as a policy change needs (${policyBar}) and at least the threshold ` +
          `(${now.threshold}). The contract would reject it.`,
      );
    }
  }

  /* ---------------- internals ---------------- */


  protected async requireDeployed(accountId: string): Promise<string> {
    const address = await this.addressOf(accountId);
    if (!address) throw new Error(`account "${accountId}" is not deployed on Midnight`);
    return address;
  }


  /**
   * Reads the account's committed state from the chain.
   *
   * Nothing about what the account has done is on chain. The ledger of
   * entries is in the sealed blob, which is why `fetch` needs both this
   * and the blob store, and why an account state without a retrievable
   * blob is fatal rather than empty. The blob is addressed by a constant,
   * so the chain says nothing about its contents at all.
   */
  protected async readContractState(address: string): Promise<{
    assets: Array<{ key: string; commitment: Hex }>;
    openProposals: Array<{ id: Hex; change: Hex; approvals: number }>;
    threshold: bigint;
    vaultThresholds: Array<{ vault: Hex; threshold: number }>;
    signerCount: bigint;
    /* The movement count and the retired vaults, both public state. */
    movementCount: bigint;
    retiredVaults: Hex[];
    updatedAt: string;
  } | null> {
    const { ledger: readLedger } = await import('../../contracts/managed/contract/index.js');
    const providers = await this.providers();

    const state = await contractStateAt(providers.publicDataProvider, address);
    if (!state) return null;

    const parsed = readLedger(state.data);
    /*
     * Read before the object below is built, so a missing map refuses
     * rather than returning a status with a zero in it.
     *
     * The pair type is written here rather than inferred, for the reason
     * `mapField`'s own note gives: the scripts tsconfig has `strict: false`
     * and will accept an `any` flowing through, so a future mismatch is
     * only a compile error if somebody wrote the shape down.
     */
    const approvalCounts = mapField<[Uint8Array, bigint]>(parsed, 'approvalCounts') as CountedMap;
    // The lifecycle fields are read because `prepare` has to know whether a
    // circuit is legal before calling it (`requireOpen` and `requireApproved`
    // use them), and because they are public by design: the threshold and
    // the approval count are what make the account auditable.
    return {

      /*
       * No assets: the contract exports no balance map, so there is nothing
       * to decode and the guard above counts the maps it does export. The
       * field stays on `LedgerStatus`, empty, because it is the shape both
       * implementations answer in.
       */
      assets: [],
      /*
       * Every open proposal, sorted so two reads of an unchanged account
       * produce an identical array: a map's iteration order is not a promise,
       * and anything that gets compared has to be stable.
       *
       * The approval count comes through `mapField` too. A map the reader did
       * not hand over would otherwise throw a `TypeError` about an internal
       * expression here, and the obvious repair to that is `?? 0n`: an unread
       * count becoming a count of zero, which is the same defect as `?? []`
       * one map along and reads just as careful. A guard on three of four
       * maps is what makes the fourth look checked.
       *
       * `lookup` rather than iteration, because the count is fetched per
       * proposal and every open proposal is guaranteed an entry by the
       * contract itself: `propose` writes `approvalCounts` for every proposal
       * it opens, one for a raiser who may approve and nought for a run's
       * raiser who may not, and `closeProposal` removes the two together.
       * Every circuit that spends or withdraws a proposal goes through
       * `closeProposal` and there is no other remover. So a proposal without
       * a count is a contract-level inconsistency, not a case this boundary
       * invents a zero for.
       */
      openProposals: [...mapField<[Uint8Array, Uint8Array]>(parsed, 'openProposals')]
        .map(([id, change]) => ({
          id: toHex(id),
          change: toHex(change),
          approvals: Number(approvalCounts.lookup(id)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      threshold: parsed.threshold,
      /*
       * The vaults somebody gave their own threshold, and no others.
       * `thresholds` is an exported ledger map, so this is a read of public
       * state and not a derivation.
       *
       * Sorted for the reason `assets` and `openProposals` are: a map's
       * iteration order is not a promise and this array gets compared.
       *
       * `Number()` on a `Uint<64>` carries the same reservation as everywhere
       * else in this file: a threshold is a count of signers, so it cannot
       * approach 2^53 for any account that could ever meet it, and a value
       * that did would be one nobody could satisfy anyway.
       *
       * An empty map here means "no vault has its own threshold" and nothing
       * else. `mapField` makes that true: a map the reader did not hand over
       * refuses above rather than arriving here as `[]`. The distinction is
       * the difference between inherit and "we could not read the
       * exceptions", which have opposite meanings.
       */
      vaultThresholds: [...mapField<[Uint8Array, bigint]>(parsed, 'thresholds')]
        .map(([vault, threshold]) => ({ vault: toHex(vault), threshold: Number(threshold) }))
        .sort((a, b) => a.vault.localeCompare(b.vault)),
      /*
       * Derived, not read: the contract keeps no `signerCount` field. Two
       * public fields meaning the same number would drift, and `Set.size()`
       * is an on-chain read. This is the only place on this boundary that
       * touches the chain for it; everything downstream reads the number this
       * line produces.
       *
       * It goes through a guard like every other field. Unguarded, a missing
       * set does not crash: `?? 0n` is the repair anybody reaches for, and a
       * seat count of zero makes this client refuse every threshold change
       * and every removal. The contract still refuses correctly, and our
       * refusals stop refusing.
       */
      signerCount: setSize(parsed, 'signerLeaves'),
      /*
       * The movement count and the retired vaults, read so a burn can be
       * detected against this boundary. Both go through the same guards as
       * everything else here: a `?? 0n` repair turns "we could not read it"
       * into a confident zero, and a confident zero here would report a burn
       * that had not happened or hide one that had.
       *
       * `movements` is a count, the set's own `size()` on chain, because the
       * comparison is between magnitudes. `retiredAt` is read for its keys
       * only: nothing removes from it, so presence means "ever retired" and
       * the marker value it stores carries nothing else.
       */
      movementCount: setSize(parsed, 'movements'),
      retiredVaults: [...mapField<[Uint8Array, bigint]>(parsed, 'retiredAt')]
        .map(([vault]) => toHex(vault))
        .sort((a, b) => a.localeCompare(b)),
      updatedAt: new Date().toISOString(),
    };
  }
}
