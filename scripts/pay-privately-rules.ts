/**
 * **THE RULES A PRIVATE PAYMENT OUT OF A VAULT APPLIES, WITH NO NETWORK IN
 * THEM.**
 *
 * The door beside this file cannot be run by whoever writes it - it proves,
 * submits and spends - so everything in it that can be wrong lives here, where
 * it is driven by a test instead.
 *
 * **WHAT IS NOT HERE IS EVERYTHING THE TWO PAYMENTS SHARE.** The record on
 * disk, the resume, the window, the approval count, the digest, the run and the
 * arguments a vault is handed are identical for a public payment and a private
 * one, and they are in `pay-from-vault-rules.ts`. Only what actually differs is
 * here: which address, which circuit, which asset, and the one question a
 * private payment has that a public one does not - whether the note this would
 * spend can be spent at all.
 */
import type { Asset, AssetRegistry } from '../src/core/assets.js';
import { ledgerFormOf } from '../src/core/assets.js';
import type { Payee, PayeeAddress } from '../src/midnight/payee-address.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';
import { choosingANoteToSpend, type Note } from '../src/midnight/vault-notes.js';
import type { Hex } from '../src/core/crypto.js';

/* ------------------------------------------------------------------ *
 * who is paid, and out of which vault
 * ------------------------------------------------------------------ */

/**
 * **THE PAYEE MUST BE A PRIVATE ADDRESS.** This door spends a note, and a note
 * is sent to a shielded coin key. A public address has no coin key to send one
 * to, so there is nothing to refuse late: it is refused before anything.
 */
export function assertPrivatePayee(payee: Payee): PayeeAddress {
  if (payee.kind === 'shielded') return payee;
  throw new Error(
    'that is a public address, and this door makes a PRIVATE payment: it spends a note and '
    + 'sends it to a shielded coin key, which a public address does not have. A public payment '
    + 'puts the address and the amount on a record anyone can read and goes through a different '
    + 'circuit and a different door. Give a private address, the kind that begins mn_shield-addr_.');
}

/** The vault must carry the private payment circuit. */
export function assertVaultCanPayPrivately(entry: VaultEntry): void {
  const circuits = Array.isArray(entry.circuits) ? entry.circuits : [];
  if (circuits.includes('payout')) return;
  throw new Error(
    `the record for the vault "${entry.name}" does not list payout, so it cannot make a private `
    + `payment. It lists: ${circuits.length ? circuits.join(', ') : '(nothing)'}. A vault is `
    + 'deployed with the circuits it will ever have and cannot be given another, so this needs a '
    + 'vault deployed from a build that has it.');
}

/* ------------------------------------------------------------------ *
 * which asset, and it is not asked for
 * ------------------------------------------------------------------ */

/**
 * **WHICH ASSET A PRIVATE PAYMENT MOVES, DERIVED RATHER THAN ASKED FOR.**
 *
 * A private payment sends a note, and a note has a colour, and a colour comes
 * off an asset's own row. **Exactly one enabled asset in this registry states a
 * private token**, so there is no choice to make and a prompt for it would be a
 * prompt with one answer - which teaches whoever runs this door to type past
 * prompts, and the next one will matter.
 *
 * It refuses on none and on more than one rather than picking. Picking the
 * first of two would settle somebody's pay in whichever currency sorts lower.
 */
export function theAssetPaidPrivately(registry: AssetRegistry): Asset {
  const payable = registry.enabled().filter(a => ledgerFormOf(a, 'shielded').of === 'token');
  if (payable.length === 1) return payable[0]!;
  if (payable.length === 0) {
    throw new Error(
      'no asset in this registry has a private form, so there is no note any payment could send '
      + 'and nothing here can be paid privately. An asset gains a private form by its row gaining '
      + 'a token; nothing is substituted.');
  }
  throw new Error(
    `${payable.length} assets have a private form (${payable.map(a => a.code).join(', ')}), so `
    + 'which one this payment settles in is a decision and this door will not make it. A door '
    + 'that picked would settle somebody\x27s pay in whichever currency happened to sort first.');
}

/**
 * **THE COLOUR IN THE REGISTRY IS THE COLOUR A MINT ACTUALLY PRODUCED.**
 *
 * A colour is sixty-four hex characters and every one of them is load-bearing:
 * a payment naming a colour nothing ever minted is a payment no note can fund,
 * discovered after the approvals and after the fees. The mint wrote down what
 * it made; this compares the two and refuses rather than proceeding on a value
 * that agrees with nothing.
 *
 * **IT IS A CHECK AND NOT A SOURCE.** The registry stays the one place an asset
 * is named. A record that is absent, or for another network, cannot make this
 * payment wrong and does not stop it - it only means the check could not be
 * made, and the caller is told which.
 */
export type ColourCheck =
  | { readonly of: 'agrees' }
  | { readonly of: 'not-checked'; readonly why: string };

export function checkTheColourWasMinted(
  token: string,
  minted: { colour?: unknown } | null,
): ColourCheck {
  const recorded = typeof minted?.colour === 'string' ? minted.colour.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(recorded)) {
    return {
      of: 'not-checked',
      why: 'this machine holds no record of a mint on this network that names a colour, so '
        + 'there is nothing to compare the registry against',
    };
  }
  if (recorded === token.trim().toLowerCase()) return { of: 'agrees' };
  throw new Error(
    'the colour this payment names is not the colour the mint on this machine recorded. One of '
    + 'the two is wrong and a payment in the wrong colour is a payment no note can fund, found '
    + 'after the approvals and after the fees. Neither value is printed here; the registry names '
    + 'the asset and the mint record names what it made.');
}

/* ------------------------------------------------------------------ *
 * whether the note can be spent, before any fee
 * ------------------------------------------------------------------ */

/**
 * **A NOTE IS SPENT AT THE PLACE THE CHAIN FILED IT, AND THAT IS READ FROM THE
 * TRANSACTION THAT CREATED IT.**
 *
 * A note whose pool entry records no such transaction is money the vault owns
 * and cannot pay out. The client refuses it - twice, once when the payment is
 * fitted and once at the spend - but both of those are after a proposal and its
 * approvals have been paid for. **This is the same question asked before the
 * first fee**, so a run that cannot end in a payment does not begin with two.
 *
 * **IT IS NOT A SECOND ANSWER. IT ASKS THE FUNCTION THE PAYMENT ASKS.** It used
 * to answer *spendable* when ANY covering note recorded its transaction, while
 * the payment chose the SMALLEST covering note whether or not it did - so a
 * vault holding a small unrecorded note and a larger recorded one passed here and
 * was refused at the spend. Now both ask `choosingANoteToSpend` with the same
 * notes, token and amount, so what this says is what the payment will do, and
 * the colour is compared exactly as the payment compares it.
 *
 * A vault holding one unrecorded note and one recorded one can make the payment
 * out of the recorded one, and the unrecorded notes it passed over are handed
 * back so the door can say they exist.
 */
export type SpendableVerdict =
  | { readonly of: 'spendable'; readonly nonce: string; readonly passedOver: readonly string[] }
  | { readonly of: 'nothing-big-enough' }
  | { readonly of: 'stranded'; readonly nonces: readonly string[] };

export function whetherANoteCanBeSpent(
  notes: readonly Note[], token: string, amount: bigint,
): SpendableVerdict {
  const choice = choosingANoteToSpend(notes, token as Hex, amount);
  if (choice.of === 'chosen') {
    return {
      of: 'spendable',
      nonce: String(choice.note.nonce),
      passedOver: choice.passedOver.map((n) => String(n.nonce)),
    };
  }
  if (choice.of === 'stranded') return { of: 'stranded', nonces: choice.notes.map((n) => String(n.nonce)) };
  return { of: 'nothing-big-enough' };
}

/**
 * **WHAT THE DOOR SAYS ABOUT A NOTE THE PAYMENT PASSED OVER.** The payment goes
 * ahead out of a note it can spend, and the money it could not reach is named
 * rather than left for somebody to notice later. Nothing when there is none.
 */
export function linesAboutNotesPassedOver(verdict: SpendableVerdict, asset: string): string[] {
  if (verdict.of !== 'spendable' || verdict.passedOver.length === 0) return [];
  const n = verdict.passedOver.length;
  return [
    `${n} other note${n === 1 ? '' : 's'} of ${asset} large enough for this payment `
    + `${n === 1 ? 'is' : 'are'} the vault's and on chain, and a payment cannot spend `
    + `${n === 1 ? 'it' : 'them'} yet: no transaction that created ${n === 1 ? 'it' : 'them'} is recorded. `
    + `This payment does not use ${n === 1 ? 'it' : 'them'}. What resolves it: record the transaction `
    + `that paid ${n === 1 ? 'it' : 'each one'} in against the note, or rebuild the pool so the chain is asked.`,
    ...verdict.passedOver.map((nonce) => `  ${nonce}`),
  ];
}

/**
 * The refusal, and it names what resolves it in terms the reader can act on.
 * When there is no refusal, the answer is handed back so the notes it passed
 * over can be named.
 *
 * **THE TWO REFUSALS ARE DIFFERENT SENTENCES BECAUSE THEY SEND A PERSON TO TWO
 * DIFFERENT PLACES.** One needs money put in; the other needs a transaction
 * recorded against money that is already there. A single "cannot pay" would
 * send half of the people who read it to do the wrong thing.
 */
export function assertANoteCanBeSpent(
  notes: readonly Note[], token: string, amount: bigint, asset: string,
): Extract<SpendableVerdict, { of: 'spendable' }> {
  const verdict = whetherANoteCanBeSpent(notes, token, amount);
  if (verdict.of === 'spendable') return verdict;
  if (verdict.of === 'nothing-big-enough') {
    throw new Error(
      `this vault holds no single note of ${asset} worth ${amount.toLocaleString()} or more, and a `
      + 'private payment is made out of ONE note. Notes are not merged to make a payment: a '
      + 'vault with two notes that add up to enough still cannot make it. Pay in a deposit large '
      + 'enough, or pay a smaller amount. Nothing was proposed, approved or paid.');
  }
  throw new Error(
    `this vault holds a note of ${asset} large enough and it cannot be spent: it does not record `
    + 'which transaction created it, and a note is spent by proving where the chain filed it, '
    + 'which is read from that transaction. The money is on chain and it is this vault\x27s; '
    + 'nothing is lost. Record the transaction that paid it in against the note, then run this '
    + `again. The note${verdict.nonces.length === 1 ? '' : 's'} this is about: `
    + `${verdict.nonces.join(', ')}. Nothing was proposed, approved or paid.`);
}
