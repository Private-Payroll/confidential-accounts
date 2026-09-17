/**
 * WHAT A TRANSACTION PROVED ON A SIGNER'S DEVICE MAY DO BEFORE WE PAY TO SEND
 * IT.
 *
 * A signer's device proves an approval and hands the proven transaction to the
 * service, which balances it and has our fee payer add the fee and submit. So
 * the service is paying for something it did not build. **It pays only for
 * calls into the company's own contract**, made by somebody the service has
 * already found to be a member of that company. Anything else - a call to
 * another contract, a deploy, a change to who maintains a contract, or a
 * transaction that calls nothing - is refused before anything is booked.
 *
 * **AND IT MAY MOVE NO COINS.** The company's side balances every imbalance in
 * whatever it is handed, and signs for it. A transaction that carried outputs
 * of its own - shielded or unshielded, in either section - would have the
 * company's wallet pay them, on the word of one member and past the company's
 * threshold. So a proven transaction carries no coin movement at all, and no
 * DUST actions: the fee is added afterwards by our fee payer, not by the device.
 *
 * The fee payer's ceiling still bounds what any one of these can cost. This
 * bounds what they can be FOR.
 */

/** A contract address, compared the way two spellings of one address are the same. */
const addressKey = (a: unknown): string => String(a).trim().toLowerCase().replace(/^0x/, '');

/** True for an offer that is absent, or present and moves nothing. False for anything else. */
const movesNothing = (offer: unknown, parts: readonly string[]): boolean => {
  if (offer === undefined || offer === null) return true;
  if (typeof offer !== 'object') return false;
  return parts.every((k) => {
    const v = (offer as Record<string, unknown>)[k];
    return Array.isArray(v) && v.length === 0;
  });
};

const SHIELDED_PARTS = ['inputs', 'outputs', 'transients'] as const;
const UNSHIELDED_PARTS = ['inputs', 'outputs'] as const;
const DUST_PARTS = ['spends', 'registrations'] as const;

const MOVES_COINS =
  'this transaction moves coins as well as calling this company\'s contract, and a '
  + 'transaction proved on a device may only call it: the company\'s wallet would pay for '
  + 'whatever it moved. Nothing was sent.';

/**
 * The refusal for a proven transaction, or `null` when it only calls the
 * company's own contract and moves no coins.
 *
 * It reads the shape the ledger publishes: a map of intents, each with a list
 * of contract actions, where a call carries the address it calls and the entry
 * point it enters. **Anything it cannot read is refused**, because paying for a
 * transaction nobody could inspect is paying for anything.
 */
export function refusalForProven(tx: unknown, contractAddress: string): string | null {
  const intents = (tx as { intents?: unknown } | null | undefined)?.intents;
  if (!(intents instanceof Map)) {
    return 'this transaction calls nothing, so there is nothing of this company\'s to send. '
      + 'Nothing was sent. Approve again from the company\'s page.';
  }
  const t = tx as { guaranteedOffer?: unknown; fallibleOffer?: unknown };
  if (!movesNothing(t.guaranteedOffer, SHIELDED_PARTS)) return MOVES_COINS;
  if (t.fallibleOffer !== undefined && t.fallibleOffer !== null) {
    if (!(t.fallibleOffer instanceof Map)) return MOVES_COINS;
    for (const offer of t.fallibleOffer.values()) {
      if (!movesNothing(offer, SHIELDED_PARTS)) return MOVES_COINS;
    }
  }
  const own = addressKey(contractAddress);
  let calls = 0;
  for (const intent of intents.values()) {
    const i = intent as {
      guaranteedUnshieldedOffer?: unknown; fallibleUnshieldedOffer?: unknown; dustActions?: unknown;
    } | null;
    if (i && (!movesNothing(i.guaranteedUnshieldedOffer, UNSHIELDED_PARTS)
      || !movesNothing(i.fallibleUnshieldedOffer, UNSHIELDED_PARTS)
      || !movesNothing(i.dustActions, DUST_PARTS))) {
      return MOVES_COINS;
    }
    const actions = (intent as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) {
      return 'this transaction could not be read, so it was not paid for. Nothing was sent. '
        + 'Approve again from the company\'s page.';
    }
    for (const action of actions) {
      const a = action as { address?: unknown; entryPoint?: unknown } | null;
      const isCall = !!a && a.entryPoint !== undefined && a.address !== undefined;
      if (!isCall) {
        return 'this transaction does something other than call this company\'s contract, and '
          + 'the product pays only for those calls. Nothing was sent.';
      }
      if (addressKey(a!.address) !== own) {
        return 'this transaction calls a contract that is not this company\'s, and the product '
          + 'pays only for calls to the company\'s own. Nothing was sent.';
      }
      calls += 1;
    }
  }
  if (calls === 0) {
    return 'this transaction calls nothing, so there is nothing of this company\'s to send. '
      + 'Nothing was sent. Approve again from the company\'s page.';
  }
  return null;
}

const entryPointName = (entryPoint: unknown): string =>
  entryPoint instanceof Uint8Array ? new TextDecoder().decode(entryPoint) : String(entryPoint);

/**
 * **AND WHEN THE SERVICE IS ABOUT TO WRITE DOWN WHAT THE TRANSACTION IS, IT
 * MUST BE EXACTLY THAT: ONE CALL, TO THE NAMED CIRCUIT.** A raise and an
 * approval are recorded against the transaction a device sent for them, so a
 * transaction that calls anything else - another circuit, or more than one -
 * would leave a record that says one thing and a chain that holds another.
 * Read after `refusalForProven`, which has already refused what cannot be read.
 */
export function refusalUnlessOnlyACallTo(tx: unknown, circuit: string): string | null {
  const intents = (tx as { intents?: unknown } | null | undefined)?.intents;
  const names: string[] = [];
  if (intents instanceof Map) {
    for (const intent of intents.values()) {
      const actions = (intent as { actions?: unknown } | null)?.actions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) names.push(entryPointName((action as { entryPoint?: unknown } | null)?.entryPoint));
    }
  }
  if (names.length === 1 && names[0] === circuit) return null;
  return `this transaction is not the one call to "${circuit}" it was sent as, so it was not paid for and `
    + 'nothing was written down. Nothing was sent.';
}

/**
 * Reads a proven, unbound transaction from its wire form, with the ledger's own
 * markers. Loaded when first used.
 */
export const readProvenTransaction = async (bytes: Uint8Array): Promise<unknown> => {
  const l: any = await import('@midnightntwrk/ledger-v9');
  return l.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
};

/**
 * A transaction a depositor's wallet has already balanced, signed and bound:
 * the reading the company's fee payer adds its fee to.
 */
export const readFinishedTransaction = async (bytes: Uint8Array): Promise<unknown> => {
  const l: any = await import('@midnightntwrk/ledger-v9');
  return l.Transaction.deserialize('signature', 'proof', 'binding', bytes);
};
