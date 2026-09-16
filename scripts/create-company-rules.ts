/**
 * WHAT THE DOOR THAT CREATES A COMPANY REFUSES, AND WHAT IT ACCEPTS AS PROOF
 * THAT ONE WAS CREATED.
 *
 * -- WHY THE RULES ARE IN A FILE OF THEIR OWN -------------------------------
 *
 * The door itself deploys a contract and spends money, so a session may write
 * it and may not run it - which leaves every refusal in it unreachable from any
 * case, and an unreachable refusal is one nobody has ever seen fire. So the
 * rules are here, they take plain values, and each of them can be watched
 * refusing without a wallet, a chain or a fee.
 *
 * **NOTHING HERE READS A FILE, OPENS A SOCKET OR SPENDS ANYTHING.** What is in
 * the door is the sequence; what is here is every decision the sequence makes.
 *
 * -- THE ONE THING A READER SHOULD KNOW BEFORE THE REST ---------------------
 *
 * **THIS DOOR CREATES A COMPANY THROUGH THE PRODUCT'S OWN BOUNDARY AND NOT
 * BESIDE IT.** It assembles the same capability a deployment would hold, starts
 * the same product, and calls the same service a person's browser calls. A
 * script that reimplemented the deploy would prove that the script works, which
 * is the one thing nobody needs to know.
 */

/** What has to be arranged before anything can be created. */
export interface CreatePreconditions {
  /** A wallet holding NIGHT, generating DUST, whose seed this machine has. */
  readonly fundedSeed: boolean;
  /** A second wallet for the company itself. It holds nothing and pays nothing. */
  readonly companySeed: boolean;
  /** The recorded decision about who may change the contract's rules. */
  readonly maintenanceAuthority: boolean;
  /** The compiled contract with its proving and verifier keys. */
  readonly compiledContract: boolean;
  /** A proof server this machine can reach. */
  readonly proofServer: boolean;
}

const WHAT_IS_MISSING: Record<keyof CreatePreconditions, string> = {
  fundedSeed:
    'this machine holds no funded wallet, and creating a company costs a network fee. The '
    + 'wallet that pays needs NIGHT and needs to have been generating DUST long enough to '
    + 'have some',
  companySeed:
    'there is no wallet for the company itself. It holds no money and pays nothing - it '
    + 'signs the parts of the transaction the company owns, which is the half a fee payer '
    + 'is deliberately not allowed to touch',
  maintenanceAuthority:
    'no decision has been recorded about who may change which proofs this contract accepts. '
    + 'It is never sampled: a sampled key is one party able to change the rules alone, '
    + 'outside the company\'s own approval threshold, and if it is lost the contract can '
    + 'never be maintained again',
  compiledContract:
    'the compiled contract and its proving keys are not on this machine, and creating a '
    + 'company is a proof against them',
  proofServer:
    'no proof server is reachable, and every write to the chain is a proof',
};

/**
 * The order the pieces are named in.
 *
 * **ACQUISITION ORDER, NOT ALPHABETICAL AND NOT THE ORDER THEY ARE CHECKED
 * IN.** Whoever reads a refusal listing three missing things is going to go and
 * arrange them, and the list is more useful in the order the work happens.
 */
export const PRECONDITIONS: Array<keyof CreatePreconditions> = [
  'maintenanceAuthority', 'compiledContract', 'proofServer', 'fundedSeed', 'companySeed',
];

/**
 * What to say when something is missing, or `null` when nothing is.
 *
 * **IT NAMES EVERY MISSING PIECE AND NOT THE FIRST ONE.** A door that stops at
 * the first is a door somebody runs five times, arranging one thing per run,
 * and each of those runs is minutes of waiting for a wallet to sync before it
 * gets to the refusal.
 *
 * **AND IT NAMES THE STATE THAT RESOLVES IT RATHER THAN A FILE TO CREATE.**
 * The person reading it is not the person who wrote the paths.
 */
export function refuseIncompleteSetup(
  present: Partial<CreatePreconditions>,
  /** The pieces this door needs; every door but the company creator needs no company wallet. */
  needed: readonly (keyof CreatePreconditions)[] = PRECONDITIONS,
): string | null {
  const missing = PRECONDITIONS.filter(p => needed.includes(p) && !present[p]);
  if (missing.length === 0) return null;
  const reasons = missing.map(p => WHAT_IS_MISSING[p]);
  const listed = reasons.length === 1
    ? reasons[0]
    : reasons.slice(0, -1).join(';\n\n  ') + ';\n\n  and ' + reasons[reasons.length - 1];
  return 'a company cannot be created from this machine yet:\n\n  ' + listed
    + '.\n\nNothing has been deployed and nothing has been spent.';
}

/**
 * What this path can seat, which is one signer.
 *
 * **IT IS A REFUSAL AND NOT A TRUNCATION, AND THE DIFFERENCE IS A DEPLOYED
 * CONTRACT AND A SPENT FEE.** The contract's constructor creates the founder's
 * seat and nothing else; every seat after it is an amendment that an existing
 * signer has to raise and an approved round has to carry. A door that accepted
 * three names would deploy a company whose record said three signers and whose
 * chain held one, report success, and tell nobody - and a record and a chain
 * that disagree about who may approve is the shape of every way this product
 * can lose money.
 */
export function refuseUnseatableCompany(signerCount: number, threshold: number): string | null {
  if (signerCount < 1) {
    return 'a company needs a founding signer. The first seat is created by the contract '
      + 'itself, and a company deployed without one can never have a signer added, because '
      + 'adding one requires an existing signer to ask.';
  }
  if (signerCount > 1) {
    return `this door can seat one signer and was given ${signerCount}. The contract creates `
      + 'the founder\'s seat; every seat after it is raised, approved and added by the founder '
      + 'from their own device, and there is no screen for that yet. Start the company with '
      + 'its founder alone.';
  }
  if (!Number.isInteger(threshold) || threshold !== 1) {
    return `a company with one signer cannot have a threshold of ${threshold}. It would be `
      + 'unable to reach its own bar and unable to lower it, because lowering it needs the bar '
      + 'to be met first.';
  }
  return null;
}

/** What the door found after it created a company. */
export interface CreatedCompany {
  readonly accountId: string;
  /** The address the chain assigned, as the product recorded it. */
  readonly recordedAddress: string | null;
  /** What the record says wrote it. Only a chain's counts. */
  readonly addressSource: string | null;
  /** Which boundary wrote the record. */
  readonly wiring: string | null;
}

/**
 * Whether a company was really created on a chain, or `null` when it was.
 *
 * **THE PRESENCE OF AN ADDRESS IS NOT THE ANSWER.** Sixty-four hex characters
 * cannot be told from sixty-four hex characters some process invented for
 * itself, which is why the record carries where the address came from and which
 * boundary wrote it, and why both are checked here. A door that reported
 * success on the address alone would report success for a company that exists
 * only in a file.
 */
export function refuseUnprovenCompany(c: CreatedCompany): string | null {
  if (!c.recordedAddress) {
    return `the company "${c.accountId}" was created and no contract address was recorded `
      + 'against it. The address exists only where the chain assigned it, so a company filed '
      + 'without one cannot be read again by anybody, and there is nothing to look up.';
  }
  if (c.addressSource !== 'chain') {
    return `the company "${c.accountId}" has an address that no chain assigned `
      + `(recorded as "${c.addressSource ?? 'nothing'}"). An address a process invented for `
      + 'itself is not a contract, and reading a company at one shows the same balances and '
      + 'the same rounds to everybody.';
  }
  if (c.wiring !== 'chain') {
    return `the company "${c.accountId}" was written by "${c.wiring ?? 'nothing'}" rather than `
      + 'by the chain boundary. A record is read back by the word it carries, so a company '
      + 'marked otherwise cannot be shown beside one a chain wrote.';
  }
  return null;
}

/**
 * The line the report ends on.
 *
 * One place, so the sentence a person reads and the sentence a check looks for
 * cannot drift apart.
 */
export const CREATED = 'A COMPANY EXISTS ON THE CHAIN, CREATED THROUGH THE PRODUCT.';
export const NOT_CREATED = 'NO COMPANY WAS CREATED. Nothing above this line succeeded.';
/**
 * **THE THIRD ANSWER, AND LEAVING IT OUT COST A SECOND FEE EVERY TIME IT WOULD
 * HAVE BEEN TRUE.**
 *
 * A company is created on the chain before it is read back, and everything from
 * that moment on - the read-back, the checks on the record, closing the wallets
 * down - can fail against a company that exists and was paid for. Reported as
 * *nothing above this line succeeded*, that is a person being told to do the
 * one thing this door says not to do twice.
 */
export const PARTLY_CREATED =
  'A COMPANY WAS CREATED AND SOMETHING AFTER IT FAILED. The fee has been spent.';
