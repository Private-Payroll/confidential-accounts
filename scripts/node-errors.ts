/**
 * What the node's numeric rejection codes actually mean.
 *
 * `1010: Invalid Transaction: Custom error: 170` is what the chain says when it
 * refuses a transaction, and on its own it is unreadable — it cost a deploy and
 * a trip through the node's Rust source to find out that 170 is
 * `MalformedError::InvalidDustSpendProof`.
 *
 * Transcribed from midnight-node `ledger/src/versions/common/types.rs`, the
 * `From<LedgerApiError> for u8` table. Only the codes we can plausibly hit are
 * listed; an unknown one still prints its number rather than being swallowed.
 *
 * Its own module on purpose: the deploy script runs `main()` at import, so a
 * test that imported this from there would start a deployment.
 */
export const NODE_ERROR_CODES: Record<string, string> = {
  '110': 'VerifierKeyNotSet',
  '111': 'TransactionTooLarge',
  '113': 'VerifierKeyNotPresent',
  '114': 'ContractNotPresent',
  '115': 'InvalidProof — the zero-knowledge proof did not verify',
  '116': 'BindingCommitmentOpeningInvalid',
  '117': 'NotNormalized — the transaction is not in canonical form. In our case: empty DustActions, i.e. the fee balancer selected no dust to spend because the computed fee was 0 (M-52)',
  '118': 'FallibleWithoutCheckpoint',
  '137': 'TooManyZswapEntries — the transaction has more Zswap inputs/outputs than the ledger allows',
  '138': 'BalanceCheckOverspend — the transaction spends more than it provides',
  '166': 'InvalidNetworkId — built for a different network than the one it was sent to',
  '167': 'IllegallyDeclaredGuaranteed',
  '169': 'InvalidDustRegistrationSignature',
  '170': 'InvalidDustSpendProof — the dust fee payment proof did not verify. Usually the dust wallet had not finished syncing when the proof was built',
  '171': 'OutOfDustValidityWindow — the dust spend was proved for a time window the block is outside of',
  '172': 'MultipleDustRegistrationsForKey',
  '173': 'InsufficientDustForRegistrationFee',
  '174': 'MalformedContractDeploy',
  '175': 'IntentSignatureVerificationFailure',
  '176': 'IntentSignatureKeyMismatch',
  '177': 'IntentSegmentIdCollision',
  '178': 'IntentAtGuaranteedSegmentId',
  '179':
    'UnsupportedProofVersion — the proof format does not match what this chain accepts. ' +
    'Every major ZKIR release changes the format, and verifier keys carry a versioned header ' +
    '(verifier-key[v6], [v7], ...). A contract compiled by one compactc, proved by a proof server ' +
    'that does not handle that header, or submitted to a node expecting another, fails here. ' +
    'Check that compactc, the proof server image and the network are the matched set (M-54).',
  '231': 'FeeCalculation: OutsideTimeToDismiss',
  '232': 'FeeCalculation: BlockLimitExceeded — the transaction is too big for a block',
  '245': 'IntentTtlExpired — the transaction took too long between being built and submitted',
  '246': 'IntentTtlTooFarInFuture',
  '247': 'IntentAlreadyExists — this exact intent has already been submitted',
  '153': 'ContractCallCostError',
  '154': 'BlockLimitExceededError',
  '155': 'FeeCalculationError',
  '156': 'ContractNotPresent — no contract at that address',
};

/** Turns "Custom error: 170" in any message into something readable. */
export function explainNodeError(text: string): string | null {
  const m = /Custom error:\s*(\d+)/.exec(text);
  if (!m) return null;
  const meaning = NODE_ERROR_CODES[m[1]!];
  return meaning ? `node rejection ${m[1]} = ${meaning}` : `node rejection ${m[1]} (not in our table)`;
}

