/**
 * The errors a vault's payment or deposit stops with when the service cannot trust what it would spend: the
 * chain unreadable, the service's note pool disagreeing with the chain, a vault short of what a payment needs,
 * and a fresh vault that already holds notes. Each says what resolves it and how to find the vault it is about.
 */


/**
 * **WHY NONE OF THE REFUSALS BELOW NAMES THE VAULT IT IS ABOUT.**
 *
 * A vault's address in an error message would read as helpful and is the one
 * value in this system that destroys money when a person acts on it: a plain
 * send to a vault's address is owned by the vault and spendable by nobody,
 * permanently, and no contract can refuse it. A vault is identified to people
 * by a NAME, and an error message is a screen too, one the screen guard does not
 * cover: an instrument's failure block deliberately does not go through
 * `createScreen`, because an error thrown from inside the guard would make the
 * failure unprintable.
 *
 * So the address is kept out of the WORDS and carried as the `vaultAddress`
 * PROPERTY, which is where a caller that genuinely needs it looks. Nothing that
 * prints an error prints a property it did not ask for, except a whole-object
 * serialiser, which is why every instrument that uses one redacts.
 *
 * The cost is real and small: an operator running two vaults sees a refusal
 * that does not say which. The instrument knows the NAME and says it, which is
 * the identifier the whole product is built on.
 */
const WHICH_VAULT =
  ' (the vault is not named here: its address is the one value that destroys money when '
  + 'somebody pastes it into a wallet, and an error message is a screen. The caller '
  + 'holds it as this error\'s `vaultAddress` property, and an instrument names the vault by '
  + 'the NAME it was deployed under.)';

/**
 * **THE CHAIN COULD NOT BE READ, WHICH IS NOT THE SAME AS THE CHAIN SAYING NO.**
 *
 * A transaction the node had finalised can read as `not found` to the indexer
 * moments later. So *"we could not check"* and *"the chain disagrees"* have opposite
 * consequences — the first is retried, the second is investigated and nothing
 * is paid until it is — and a caller that cannot tell them apart will do the
 * wrong one of those two things.
 */
export class VaultChainUnreadable extends Error {
  constructor(
    readonly vaultAddress: string,
    why: string,
    /**
     * **WHICH OF THE VAULT'S TWO BALANCES COULD NOT BE READ.** It is a
     * parameter rather than a second class.
     *
     * A caller must NOT be able to act on the difference — *"we could not
     * check"* has one consequence whichever half of the vault it is about, and
     * that is the whole reason this class is separate from
     * `VaultPoolDisagreesWithChain`. So there is one class and one
     * `catch`. What differs is only the sentence a person reads, and the two
     * sentences are not interchangeable: on the private side there IS a local
     * number and withholding it is the deliberate act; on the public side
     * **there is no local number at all**, because the chain's own figure is
     * the only record there has ever been.
     */
    about: 'note-pool' | 'public-balance' = 'note-pool',
  ) {
    super(
      `this vault's balance cannot be confirmed, because the chain could not be read: ${why}. ` +
      (about === 'note-pool'
        ? '**No local number is returned, deliberately** — the pool alone is our bookkeeping ' +
          'and not the money, and a balance nothing has reconciled is the thing this refusal ' +
          'exists to stop being shown. '
        : '**There is no local number to fall back to, and that is the design rather than a ' +
          'gap** — a contract\'s unshielded balance is the LEDGER\'s own figure, per contract ' +
          'per colour, and this client keeps no second copy of it. ') +
      'This is NOT the chain disagreeing; it is us not knowing. Retry, ' +
      'and if it persists look at the indexer rather than the pool.' + WHICH_VAULT);
    this.name = 'VaultChainUnreadable';
  }
}

/**
 * **THE POOL AND THE CHAIN DISAGREE, SO THERE IS NO BALANCE TO REPORT.**
 *
 * Not a smaller balance and not a caveated one. The pool is our record of which
 * notes exist; the chain holds the commitments. When they differ, the vault's
 * spendable balance is unknown until somebody reconciles them, and a number
 * shown in the meantime is one a payroll run would be sized against.
 */
export class VaultPoolDisagreesWithChain extends Error {
  constructor(readonly vaultAddress: string, detail: string) {
    super(
      `this vault's pool disagrees with the chain, so it has no balance to report: ${detail}. ` +
      'Rebuild the pool from the chain before spending — see replayVault in ' +
      'src/midnight/vault-recovery.ts.' + WHICH_VAULT);
    this.name = 'VaultPoolDisagreesWithChain';
  }
}

/**
 * **A RUN THAT CANNOT BE PAID OUT OF THIS VAULT, FOR ANY OF THREE REASONS.**
 *
 * One type rather than three, deliberately. The three reasons are
 * distinguishable — `cause` carries the original — but a caller must not be
 * able to act on the difference, because there is no version of *"the chain
 * could not be read"* or *"the pool disagrees with the chain"* that means it is
 * safe to start paying people. **EITHER REFUSAL IS `cannot afford`**, and the
 * failure this replaces is a caller that reads a refusal, decides it was only a
 * read problem, and starts a run against an unreconciled pool: it pays until it
 * stops, mid-run, and the person who goes unpaid is picked at random.
 */
export class VaultCannotAfford extends Error {
  constructor(
    readonly vaultAddress: string,
    readonly why: 'chain-unreadable' | 'pool-disagrees' | 'notes-do-not-cover'
      /**
       * **THE PUBLIC SIDE'S ONLY SHORTFALL, AND IT IS A SUM.**
       *
       * There is no `public-balance-disagrees`, because there is nothing local
       * that could disagree — see `unshieldedBalance`. And there is no note
       * arithmetic: an unshielded balance is one number the ledger subtracts
       * from, so a total IS the question here, which is exactly what it is not
       * on the private side (`noteToSpend` does not merge).
       */
      | 'public-balance-short',
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `this run cannot be paid out of this vault (${why}): ${detail} — so nothing is submitted. ` +
      '**A run started against a pool nothing has reconciled pays until it stops**, and it ' +
      'stops mid-run: the payees before the shortfall are paid, the ones after are not, and ' +
      'the split is arbitrary.' + WHICH_VAULT, options);
    this.name = 'VaultCannotAfford';
  }
}

/**
 * **THIS VAULT ALREADY HOLDS NOTES, SO ITS POOL CANNOT BE STARTED EMPTY.**
 *
 * An empty pool and an unreadable pool are opposite claims about a company's
 * treasury, and `SealedNotePool` keeps them apart on the READ side: an absent
 * record throws, never `{notes: []}`. Creating one is the other side of the
 * same rule, and it is where the confusion could be MANUFACTURED — a vault
 * whose pool record was lost is a vault for which `create` succeeds and writes
 * a truthful-looking empty pool over a treasury that is not empty. `balance`
 * would then report zero and every note on chain would be unexplained.
 *
 * So an empty pool may only be created for a vault the CHAIN agrees is empty.
 */
export class VaultAlreadyHoldsNotes extends Error {
  constructor(readonly vaultAddress: string, holds: bigint) {
    super(
      `refusing to start an EMPTY note pool for a vault whose on-chain set holds ${holds} ` +
      'note(s). An empty pool is a claim that this vault has no money, and writing one here ' +
      'would make that claim about a treasury that exists: balance would report zero and every ' +
      'commitment on chain would read as unexplained. **This is not a new vault** — it is a ' +
      'vault whose pool record is missing, which is what replayVault ' +
      '(src/midnight/vault-recovery.ts) rebuilds, from the chain and the payment history. ' +
      WHICH_VAULT);
    this.name = 'VaultAlreadyHoldsNotes';
  }
}
