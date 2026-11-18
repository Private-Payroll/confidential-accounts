/**
 * Building the call for each step a company takes on its account contract, once the chain checks the step needs
 * have passed: the circuit's arguments, and what the step stages in the calling device's private state first.
 * A step whose values could never reach the chain, or that the chain's current state would refuse, is refused
 * here before anything is proved or sent.
 */
import type { StateChange } from '../core/ledger.js';
import type { AccountPrivateState } from '../../contracts/src/witnesses.js';
import type { Hex } from '../core/crypto.js';
import { toHex, fromHex } from '../core/crypto.js';
import { periodWindowOf, policyCommitmentOf, policyBarKey } from './spending-policy.js';
import { retryArgsOf } from './spending-policy-record.js';
import { assetIdBytes } from '../core/assets.js';
import { MidnightCommitments } from './commitments.js';
import { seatBarParts } from './already-paid.js';
import { AccountReads, ZERO_32 } from './account-reads.js';
import type { PreparedStep, PreparedCall, RunOpeningHex } from './ledger.js';
type StepOf<K extends PreparedStep['kind']> = Extract<PreparedStep, { kind: K }>;


/**
 * Where one account's private state is filed.
 *
 * Exported, and used by the scripts as well as by this class, because it is a
 * rule and rules in this project have a habit of being written twice. The
 * suffix exists because one `MidnightLedger` serves many accounts while a
 * script drives one; without a shared function the two conventions diverge and
 * the run script looks for a key the deploy never wrote. Caught before shipping
 * this time — it is the ninth instance of the pattern.
 */
export const privateStateKey = (base: string, accountId: string): string =>
  `${base}:${accountId}`;

/**
 * The truthful missing-private-state message.
 *
 * It does not say the device lacks the account's secret key, which is one of
 * two causes and not the likelier one once a second contract exists: private
 * state is filed under `${contractAddress}:${key}`, so state written while a
 * different contract was addressed is invisible here without being gone. The
 * message says what is actually missing, a staged entry for this contract, and
 * names both ways that happens, because reporting the wrong one would send
 * people to re-seat signers whose state was one prefix away.
 */
const missingPrivateState = (accountId: string, address: string): string =>
  `no private state for "${accountId}" under contract ${address} on this device. ` +
  'Either this device was never seated on the account — it holds no secret key or ' +
  'blinding factor for it — or the account\'s private state was written under a ' +
  'different contract address. Nothing is staged for THIS contract either way, and ' +
  'proving without it would prove against another contract\'s view.';

/**
 * The `deadline` a raise carries: the last block time, in seconds, it may land at. Refused before
 * anything is staged when it is missing or is not a time in seconds, since the chain would refuse
 * the raise at once or never bound it.
 */
const raiseByRequired = (raiseBy: bigint | undefined): bigint => {
  if (raiseBy === undefined) {
    throw new Error('this raise does not carry the time it must reach the chain by, so it was not built. Nothing was sent.');
  }
  if (raiseBy <= 0n || raiseBy > 32_503_680_000n) {
    throw new Error(`${raiseBy} is not a time in seconds the raise could reach the chain by, so it was not built. Nothing was sent.`);
  }
  return raiseBy;
};

export class AccountSteps extends AccountReads {
  /** Builds the call for a step that raises, approves, holds, releases, cancels or closes a proposal or a run, after the chain checks each needs. */
  protected async prepareRunStep(
    accountId: string, step: StepOf<'propose' | 'proposeRun' | 'closeExpiredRun' | 'approve' | 'cancel' | 'holdRun' | 'releaseHold'>,
    address: string, privateStateId: string | null, circuit: string,
  ): Promise<PreparedCall> {
    switch (step.kind) {
      case 'propose': {
        /*
         * There is deliberately no "a proposal is already open" refusal: an
         * admin can raise a vendor invoice while payroll collects signatures.
         *
         * `propose` records the change and reads it from the caller's private
         * state, because the circuit takes no argument for it. Staging is
         * therefore not optional here: this is the only circuit that opens what
         * is staged below, and nothing on chain reopens what it commits to.
         */
        /*
         * The vault is refused before anything is staged. The contract asserts
         * the same on this branch; refusing here costs no fee and no minutes of
         * proving, and it must come before the durable private-state write
         * below: a refusal after `stageChange` would leave the caller's device
         * holding a `proposalSalt` for a proposal that was never raised, and the
         * next governance apply would recompute the wrong id and refuse about
         * the wrong thing. It reads nothing staging produces, so it sits above it.
         *
         * The caller names the second argument; it is never defaulted here. The
         * vault is committed inside the proposal's identity, so a wrong value
         * does not fail loudly, it produces an id nobody can claim.
         */
        if (step.vault !== MidnightCommitments.noVault()) throw new Error('a governance round cannot name a vault');
        const raiseBy = raiseByRequired(step.raiseBy);
        await this.stageChange(accountId, step.change);
        /*
         * The merged `propose`: the opaque path. `isRun` is false and the run
         * parts are zero, so the branch that would read them is not taken.
         */
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(step.payloadHash), fromHex(ZERO_32), 0n, 0n, 0n, 0n, false, fromHex(step.vault), raiseBy,
          ],
        };
      }

      case 'proposeRun': {
        /*
         * Refuse early. All three refusals are free of side effects: they read
         * `step` alone, nothing `stageChange` produces, so they sit above it. A
         * refusal after staging would leave the device holding a `proposalSalt`
         * for a proposal never raised, and the next apply for a legitimately
         * open proposal would recompute the wrong id and be refused about the
         * wrong thing. The duplication with the chain is deliberate: its asserts
         * give an attacker nothing; these give a person a sentence.
         */
        if (step.payees < 1n) {
          throw new Error('a payroll run needs at least one payee');
        }
        if (step.opensAt >= step.closesAt) {
          throw new Error(
            `this run's window closes at ${step.closesAt} and opens at ${step.opensAt}, ` +
              'so no payment could ever fall inside it');
        }
        /*
         * A WINDOW IN MILLISECONDS IS THE MISTAKE THIS CATCHES. The contract
         * compares against `secondsSinceEpoch`, so a JavaScript timestamp
         * passed straight through builds a run that opens in the year 56000 —
         * approved, paid for, and unpayable, with nothing to say why. Anything
         * past the year 3000 is not a payroll date.
         */
        if (step.closesAt > 32_503_680_000n) {
          throw new Error(
            `${step.closesAt} is not a time in seconds — that is the year ${
              new Date(Number(step.closesAt) * 1000).getUTCFullYear()}. ` +
              'Block time is seconds since the Unix epoch, not milliseconds.');
        }
        const raiseBy = raiseByRequired(step.raiseBy);
        await this.stageChange(accountId, step.change);
        /* The MERGED `propose`: the run path. `isRun` true, opaque hash zero. */
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(ZERO_32), fromHex(step.root), step.payees, step.opensAt, step.closesAt,
            step.required ?? 0n, true, fromHex(step.vault), raiseBy,
          ],
        };
      }

      case 'closeExpiredRun': {
        /*
         * No `requireOpen` beyond the contract's own. This step removes an
         * authorisation that is already dead — every payment asserts the same
         * bound — so the only thing a stale local view can cause is a refused
         * transaction, and refusing here would need a second opinion about the
         * block time that we do not have.
         */
        /*
         * **AND IT CARRIES NO PRIVATE-STATE KEY, WHICH IS THE ONE `null` IN
         * THIS METHOD - AND IT IS NOW DERIVED RATHER THAN WRITTEN HERE**, from
         * the circuit this step names and the set of circuits that read no
         * witness. This circuit calls no witness - no signer check, no
         * salt, no asset - so there is nothing for a record to answer. Asking
         * for one would refuse a sweep from any client that has never staged
         * a call against this account, and the contract's whole argument for
         * leaving this operation open to anybody is that an account whose
         * signers have all left must still be able to have its expired rows
         * taken out. Passing a key it does not need would also put this call
         * on the path where the SDK writes the record back after settlement,
         * for a circuit that changed nothing in it.
         */
        return {
          address, privateStateId, circuit,
          args: [fromHex(step.proposalId)],
        };
      }

      case 'approve': {
        await this.requireOpen(address, step.proposalId, 'approve');
        if (step.opening) await this.stageOpening(accountId, step.proposalId, step.opening);
        /*
         * Deliberately no check for "have I already approved". It cannot be
         * done: the nullifier is H(domain, address, proposal, secretKey) and
         * the secret never leaves the signer's device. The contract rejects the
         * duplicate, and a local check that looked authoritative would be a lie
         * about what we can know.
         */
        return {
          address, privateStateId, circuit, args: [fromHex(step.proposalId)],
        };
      }

      case 'cancel': {
        await this.requireOpen(address, step.proposalId, 'cancel');
        return {
          address, privateStateId, circuit, args: [fromHex(step.proposalId)],
        };
      }

      case 'holdRun': {
        await this.requireOpen(address, step.proposalId, 'hold this run');
        if (step.opening) await this.stageOpening(accountId, step.proposalId, step.opening);
        return {
          address, privateStateId, circuit, args: [fromHex(step.proposalId)],
        };
      }

      case 'releaseHold': {
        await this.requireOpen(address, step.proposalId, 'release the hold on this run');
        return {
          address, privateStateId, circuit, args: [fromHex(step.proposalId)],
        };
      }
    }
  }

  /** Builds the call for a step that changes who sits in the company's seats or how many approvals it needs, after the chain checks each needs. */
  protected async prepareSeatStep(
    _accountId: string, step: StepOf<'reseatSigner' | 'setPolicyBar' | 'setThreshold' | 'removeSigner'>,
    address: string, privateStateId: string | null, circuit: string,
  ): Promise<PreparedCall> {
    switch (step.kind) {
      case 'reseatSigner': {
        await this.requireSeatBar(address, step.proposalId, "change a signer's seat");
        await this.refuseUnusableLeaf(step.newLeaf, 'the signer leaf being seated');
        return {
          address, privateStateId, circuit,
          args: [fromHex(step.oldLeaf), fromHex(step.newLeaf), fromHex(step.proposalId)],
        };
      }

      case 'setPolicyBar': {
        await this.requireSeatBar(address, step.proposalId, 'change the approvals a policy change needs');
        if (!Number.isInteger(step.newBar) || step.newBar < 1) {
          throw new Error('a policy change needs at least one approval, and a whole number of them');
        }
        {
          const now = await this.readContractState(address);
          if (!now) throw new Error('the contract has no state on chain');
          if (BigInt(step.newBar) > now.signerCount) {
            throw new Error(
              `a policy change cannot need ${step.newBar} approvals when the company has ${now.signerCount} signers; ` +
                'seat more signers first, or choose a smaller number.',
            );
          }
        }
        return {
          address, privateStateId, circuit,
          args: [BigInt(step.newBar), fromHex(step.proposalId)],
        };
      }

      case 'setThreshold': {
        const before = await this.readContractState(address);
        if (!before) throw new Error('the contract has no state on chain');
        await this.requireApproved(address, step.proposalId, 'change the threshold');
        /*
         * `Number.isInteger` is here because the vault-threshold path has it
         * too: without it `NaN` would reach `BigInt(...)` and throw a
         * `RangeError` naming nothing anybody can act on, while the vault path
         * answers in a sentence. Two mirrors of one rule must not disagree.
         */
        if (!Number.isInteger(step.newThreshold) || step.newThreshold < 1) {
          throw new Error('the threshold must be at least one, and a whole number');
        }
        /*
         * A threshold above the seated signers would leave an account that can
         * never approve anything again.
         */
        if (BigInt(step.newThreshold) > before.signerCount) {
          throw new Error(
            `the threshold cannot exceed the ${before.signerCount} signers on this account, ` +
              'or one signer could seat their own.',
          );
        }
        return {
          address, privateStateId, circuit,
          args: [BigInt(step.newThreshold), fromHex(step.proposalId)],
        };
      }

      case 'removeSigner': {
        const before = await this.readContractState(address);
        if (!before) throw new Error('the contract has no state on chain');
        await this.requireSeatBar(address, step.proposalId, 'remove a signer');
        if (before.signerCount - 1n < before.threshold) {
          throw new Error(
            `that would leave ${before.signerCount - 1n} signers against a threshold of ` +
              `${before.threshold}, and the account could never approve anything again.`,
          );
        }
        /* The circuit's second floor: never fewer signers than a policy change needs. */
        const { policyBar } = seatBarParts(before);
        if (before.signerCount - 1n < policyBar) {
          throw new Error(
            `that would leave ${before.signerCount - 1n} signers when a policy change needs ${policyBar}; ` +
              'seat another signer first, or lower the approvals policy changes need.',
          );
        }
        /* The leaf leaving, 0 to keep the threshold in force, and the approved removal. */
        return {
          address, privateStateId, circuit,
          args: [fromHex(step.removedLeaf), 0n, fromHex(step.proposalId)],
        };
      }
    }
  }

  /** Builds the call that changes one vault's threshold, refusing a threshold the company's seats or its policy bar cannot support. */
  protected async prepareVaultThresholdStep(
    _accountId: string, step: StepOf<'setVaultThreshold'>,
    address: string, privateStateId: string | null, circuit: string,
  ): Promise<PreparedCall> {
    switch (step.kind) {
      case 'setVaultThreshold': {
        /*
         * The account's threshold, not the vault's. This matches the circuit:
         * `setVaultThreshold` calls `requireApproved(id)`, the entry point with
         * no vault lookup, because the proposal behind it names `noVault()`. A
         * vault whose bar is already 1 must not be able to authorise its own
         * further changes with one signature.
         */
        await this.requireApproved(address, step.proposalId, "change a vault's threshold");
        /*
         * This is narrower than the contract's check, deliberately. The contract
         * refuses exactly a threshold of zero, and its reason is the best
         * statement of why: "a vault threshold of zero would authorise
         * anything". This refuses `NaN`, non-integers and everything below 1. It
         * errs safe: it is strictly narrower, and the contract's unsigned type
         * makes a negative unrepresentable on the far side anyway. Do not loosen
         * this line to match the contract's: a non-integer is a bad value
         * entering our own records.
         *
         * The signer-count bound is the circuit's, as `setThreshold`'s is above:
         * the circuit refuses a vault threshold above the signers seated, and
         * the block below mirrors it. The application also refuses to raise such
         * a proposal: `AccountService.proposeVaultThresholdChange`.
         */
        if (!Number.isInteger(step.newThreshold) || step.newThreshold < 1) {
          throw new Error('a vault threshold of zero would authorise anything');
        }
        /*
         * The circuit's two further rules, mirrored so a proposal the chain
         * would refuse is refused here before a fee is paid: no more than the
         * signers seated, and as many approvals as a change of who is seated
         * when the new number is above the approvals a policy change needs (it
         * raises that number to it) or below what the vault needs today.
         */
        {
          const now = await this.readContractState(address);
          if (!now) throw new Error('the contract has no state on chain');
          if (step.vault === toHex((await import('../../contracts/managed/contract/index.js')).pureCircuits.companyWide())) {
            throw new Error("the company-wide decision always takes the account's threshold, so it has no vault threshold.");
          }
          if (step.vault === policyBarKey()) {
            throw new Error('that is not a vault; to change the approvals a policy change needs, raise that change instead.');
          }
          if (BigInt(step.newThreshold) > now.signerCount) {
            throw new Error(
              `a vault cannot need ${step.newThreshold} approvals when the company has ${now.signerCount} signers; ` +
                'seat more signers first, or choose a smaller number.',
            );
          }
          const barNow = seatBarParts(now).policyBar;
          if (BigInt(step.newThreshold) > barNow && !(await this.readGovernance(address)).holdsVault(step.vault)) {
            throw new Error(
              `that is not a vault this company holds, so its threshold cannot exceed ${barNow}, the approvals ` +
                'a policy change needs; adopt the vault first, or choose a smaller number.',
            );
          }
          const own = now.vaultThresholds.find(v => v.vault === step.vault);
          const today = own ? own.threshold : Number(now.threshold);
          if (step.newThreshold > Number(seatBarParts(now).policyBar) || step.newThreshold < today) {
            await this.requireSeatBar(address, step.proposalId, "change a vault's threshold");
          }
        }
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(step.vault), BigInt(step.newThreshold), fromHex(step.proposalId),
          ],
        };
      }
    }
  }

  /** Builds the call for a vault's spending policy, a run charged to it, or the company's sealed pay-record key, after the chain checks each needs. */
  protected async preparePolicyStep(
    accountId: string, step: StepOf<'setPolicy' | 'clearRun' | 'sealPayKey'>,
    address: string, privateStateId: string | null, circuit: string,
  ): Promise<PreparedCall> {
    switch (step.kind) {
      case 'setPolicy': {
        await this.requireSeatBar(address, step.proposalId, "set this vault's spending policy");
        if (step.vault === MidnightCommitments.noVault()) throw new Error('a spending policy is set on a vault');
        if (!(await this.readGovernance(address)).holdsVault(step.vault)) {
          throw new Error('that is not a vault this company holds; adopt the vault first, then set its policy.');
        }
        await this.stageFor(accountId, { assetId: assetIdBytes(step.asset), policy: step.policy });
        return {
          address, privateStateId, circuit,
          args: [fromHex(step.vault), fromHex(policyCommitmentOf(step.policy)), fromHex(step.proposalId)],
        };
      }

      case 'clearRun': {
        const window = periodWindowOf(step.policy, step.period);
        if (step.run.opensAt < window.from || step.run.closesAt > window.until) {
          const day = (t: bigint) => new Date(Number(t) * 1000).toISOString().slice(0, 10);
          throw new Error(
            `this run's window, ${day(step.run.opensAt)} to ${day(step.run.closesAt)}, does not lie inside ` +
              `the period ${day(window.from)} to ${day(window.until)} of its vault's policy, so it cannot be ` +
              'charged to it. Charge it to the period its window lies in; if its window crosses two periods, ' +
              'raise the run again inside one.');
        }
        await this.stageFor(accountId, {
          assetId: assetIdBytes(step.asset), policy: step.policy, periodSpent: step.spent,
        });
        return {
          address, privateStateId, circuit,
          args: [
            fromHex(step.proposalId), fromHex(step.run.vault), fromHex(step.run.root), step.run.payees,
            step.run.opensAt, step.run.closesAt, step.run.required ?? 0n, fromHex(step.salt),
            step.top, step.total, step.period, ...retryArgsOf(fromHex(step.fresh)),
          ],
        };
      }

      case 'sealPayKey': {
        if (step.wrap.length !== 4 || step.wrap.some(p => fromHex(p).length !== 32)) {
          throw new Error('a sealed pay-record key is four 32-byte entries');
        }
        const committed = await this.payKeyCommitmentAt(address);
        if (committed === null) {
          /*
           * Never first-come. The first copy writes the commitment every later
           * device checks its key against, so it is written only under a
           * proposal every approving signer named it in.
           */
          if (!step.proposalId) {
            throw new Error(
              'nobody has confirmed this company\'s pay-record key on chain yet. Raise a proposal '
              + 'that names it, get it approved, then seal your copy again with that proposal.');
          }
          await this.requireApproved(address, step.proposalId, 'commit this company to its pay-record key');
        } else if (committed.toLowerCase() !== step.commitment.toLowerCase()) {
          throw new Error(
            'the pay-record key on this device is not the one this company confirmed on chain, so it '
            + 'cannot be sealed. Reopen the company\'s key from its sealed records and try again.');
        }
        return {
          address, privateStateId, circuit,
          args: [
            step.wrap.map(p => fromHex(p)), fromHex(step.commitment),
            fromHex(step.proposalId ?? '00'.repeat(32)),
          ],
        };
      }
    }
  }




  /**
   * The account's asset blinding, from this device's private state.
   *
   * Throws rather than defaulting. A wrong or missing blinding derives a
   * different asset key, so the change commitment `propose` writes is not
   * the one this device recomputes in its own post-check, and the call
   * fails with "the chain recorded a different change than the one
   * supplied", which is true of the commitment and says nothing of the
   * cause.
   *
   * The error below says the blinding is what derives the asset key the
   * change commitment is built from, and that every signer needs the same
   * one. It does not say the other signers approve that commitment:
   * `approve` takes a proposal id and nothing else, the id does not
   * contain the change, and no circuit reopens the change. The consequence
   * that is true is the one stated above: this device cannot compute or
   * check the commitment a proposal carries.
   */
  protected async assetBlindingOf(accountId: string): Promise<Hex> {
    const providers = await this.providers();
    // Read under the account's own contract address, like every other private
    // state access: another contract's blinding would derive a different asset
    // key, and so a change commitment this account's own signers cannot reproduce.
    const existing = await providers.privateStateProvider.forContract(await this.requireDeployed(accountId)).get(
      privateStateKey(this.cfg.privateStateId, accountId));
    if (!existing?.assetBlinding) {
      throw new Error(
        `no asset blinding in the private state for "${accountId}" on this device. ` +
          'It is written when the account is opened and every signer needs the same one — ' +
          'without it this device cannot derive the account\'s asset key, and so cannot ' +
          'compute or check the change commitment a proposal carries.',
      );
    }
    return toHex(existing.assetBlinding);
  }

  protected async changeCommitmentOf(c: StateChange, assetBlinding: Hex): Promise<Hex> {
    const { pureCircuits } = await import('../../contracts/managed/contract/index.js');
    /*
     * No cast: the circuit's typed arity is checked at compile time, so a
     * changed parameter list fails the build instead of being hidden.
     */
    return toHex(
      pureCircuits.changeCommitmentOf(
        fromHex(MidnightCommitments.assetKey(c.asset, assetBlinding)),
        c.amount,
        fromHex(c.batchDigest),
        fromHex(c.salt),
      ),
    );
  }

  /**
   * Puts the approved change where the witnesses will find it.
   *
   * `changeAmount`, `changeBatchDigest` and `proposalSalt` are read from
   * the calling device. `propose` is the only circuit that reads the
   * first two and nothing on chain reopens what it writes. `proposalSalt`
   * also has readers later: every governance circuit and `recordPayment`
   * recompute the proposal's id from it.
   *
   * Merged rather than replaced: a device's private state holds more than
   * one call's worth of witnesses, and overwriting the record would drop
   * the ones this call does not set.
   */
  private async stageChange(accountId: string, change: StateChange): Promise<void> {
    const providers = await this.providers();
    // The private state is opened under the account this stage is for, never another contract's.
    const address = await this.requireDeployed(accountId);
    const states = providers.privateStateProvider.forContract(address);
    const key = privateStateKey(this.cfg.privateStateId, accountId);
    const existing = await states.get(key);
    if (!existing) {
      throw new Error(missingPrivateState(accountId, address));
    }
    await states.set(key, {
      ...existing,
      // The asset travels with the change, because `propose` derives the asset
      // key from it.
      assetId: assetIdBytes(change.asset),
      changeAmount: change.amount,
      changeBatchDigest: fromHex(change.batchDigest),
      proposalSalt: fromHex(change.salt),
    });
  }

  /** Stages what one run's id opens to, beside any this device already holds. */
  private async stageOpening(accountId: string, proposalId: Hex, opening: RunOpeningHex): Promise<void> {
    const providers = await this.providers();
    const address = await this.requireDeployed(accountId);
    const states = providers.privateStateProvider.forContract(address);
    const key = privateStateKey(this.cfg.privateStateId, accountId);
    const existing: AccountPrivateState | null = await states.get(key);
    if (!existing) throw new Error(missingPrivateState(accountId, address));
    await this.stageFor(accountId, {
      runOpenings: {
        ...(existing.runOpenings ?? {}),
        [proposalId.replace(/^0x/, '').toLowerCase()]: {
          payload: fromHex(opening.payload), vault: fromHex(opening.vault), salt: fromHex(opening.salt),
        },
      },
    });
  }

  /**
   * Writes the named values into this account's private state on this device,
   * beside what is already there, for a call whose witnesses read them.
   */
  private async stageFor(accountId: string, values: Partial<AccountPrivateState>): Promise<void> {
    const providers = await this.providers();
    const address = await this.requireDeployed(accountId);
    const states = providers.privateStateProvider.forContract(address);
    const key = privateStateKey(this.cfg.privateStateId, accountId);
    const existing = await states.get(key);
    if (!existing) throw new Error(missingPrivateState(accountId, address));
    await states.set(key, { ...existing, ...values });
  }
}
