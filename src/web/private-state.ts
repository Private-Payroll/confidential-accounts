/**
 * **THE RECORD A GOVERNED CALL RUNS AGAINST, COMPOSED ON THE DEVICE THAT HOLDS
 * THE SIGNER'S OWN MATERIAL, AND NEVER WRITTEN DOWN WHOLE.**
 *
 * -- WHAT THIS REPLACES, AND WHY THE OBVIOUS THING IS THE WRONG THING -------
 *
 * The scheme a circuit reads its private half from is an ordinary key-value
 * store in every other client: the call names a key, the store answers with a
 * record, the record carries the signer's secret key. That shape is unavailable
 * here, and not for tidiness. **A store holding one signer's secret can produce
 * every signature that secret will ever produce**, which turns a company of
 * five people who must all agree into a company of whoever can read that store.
 *
 * So there is no store of records here. There is a VIEW over two sources with
 * two different lifetimes:
 *
 *   THE SIGNER'S OWN MATERIAL   their secret key, their blinding, their scope.
 *                    Held in memory for the length of a session, put there by
 *                    the person unlocking their own keyring, and composed into
 *                    a record at the moment a circuit asks for one. **It is
 *                    never written to anything, on any machine, including this
 *                    one.**
 *
 *   THE ACCOUNT'S HALF   which asset a call concerns, the account's asset
 *                    blinding, the salt and the change a proposal commits to.
 *                    Staged before a call, and it has to survive a proof that
 *                    takes minutes and a page that may be reloaded in the
 *                    middle of one - so something durable holds it, and WHAT
 *                    holds it is this module's caller's decision rather than
 *                    this module's.
 *
 * `get` puts the two together. `set` takes them apart again and writes only the
 * second. The first half makes the round trip and lands nowhere.
 *
 * -- THE WRITE NOBODY MAKES ON PURPOSE, WHICH IS WHY `set` IS NOT A PASS-THROUGH
 *
 * After a transaction that succeeds entirely, the scheme puts the record the
 * call ran with back into the store the call was configured against. That is
 * correct behaviour and it is invisible: nothing above it calls it, nothing
 * logs it, and it happens after the money has moved and the screen has said so.
 * **A `set` that wrote what it was handed would therefore acquire a signing key
 * on the first successful call, silently, and nothing anywhere would go red.**
 *
 * The list of what may never be written, and the reason beside each name, is in
 * `../midnight/what-a-device-may-persist.js`. This file is the first caller of
 * it, and the refusal below is a control rather than a guard: it can only fire
 * if the function that drops them has stopped dropping them.
 *
 * -- AND THE READ IS FILTERED TOO, WHICH IS THE HALF THAT IS EASY TO MISS ---
 *
 * The account's half may be kept somewhere another party can write - it is
 * ciphertext they cannot open, but it is bytes they hand back. **Two of the
 * fields on this record forge a membership path**, and a record composed partly
 * from material another party holds is a record another party can put one into.
 * A forged path is not a wrong number: the tree accepts only its current root,
 * so a path from before the tree moved stops verifying, and what the circuit
 * then says is "you are not a signer on this account" - to somebody who is, on
 * a device that looks completely healthy, for as long as the record survives.
 *
 * So what comes back from the store is stripped of all five on the way IN as
 * well as on the way out. Of the two path fields, one is then written here from
 * a constant and the other is left absent, which is the same answer by two
 * routes: the witness short-circuits only on a path that is there.
 *
 * -- WHAT A SECOND SIGNER NEEDS, WHICH IS LESS THAN IT LOOKS ----------------
 *
 * Approving a round somebody else raised reads FOUR things: the approver's own
 * secret key, their blinding, their scope, and a path through the signer tree -
 * and the tree is public. It reads no salt, no asset and no amount. **So a
 * device that has never staged anything against an account can still approve on
 * it**, and the type below says so rather than a comment: the signer's three
 * are always present and the account's half is optional. A record with no
 * account half is a complete record for an approval and an incomplete one for a
 * proposal.
 *
 * **AND WHAT HAPPENS TO THE PROPOSAL IS NOT YET A SENTENCE ANYBODY CAN ACT ON,
 * WHICH IS SAID HERE RATHER THAN ASSUMED AWAY.** One field of the account's
 * half - the account's asset blinding - is written when a company is OPENED and
 * by nothing else, so a signer seated afterwards has a half without it. Answering
 * with a composed record is what lets that signer approve; it is also what stops
 * the refusal that used to fire when a device held no record at all. A proposal
 * raised from such a device reaches the circuit and fails inside it on a field
 * that is not there, before any proof and before any fee, in words that name
 * none of this. **Rebuilding that half on the device that needs it is the work
 * this does not do**, and until it is done a second signer can approve and
 * cannot raise.
 *
 * -- THE CONTRACT ADDRESS IS AN ARGUMENT AND NOT A REMEMBERED FIELD ---------
 *
 * The scheme's own interface carries the address as a setter, and every store
 * behind it keeps it in a mutable field that whichever entry point ran last has
 * written. A read that inherits the wrong one answers with another contract's
 * record. This file honours the setter because the scheme calls it, and then
 * passes the address DOWN as an argument on every call, so the store underneath
 * cannot answer under an address nobody asked it for.
 */
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';

import type { AccountPrivateState } from '../../contracts/src/witnesses.js';
import { fromHex, toHex, type Hex } from '../core/crypto.js';
import {
  persistableAccountHalf,
  refuseToPersistWhatMustNotBeStored,
  type NeverPersistedField,
  type SignerOnlyField,
} from '../midnight/what-a-device-may-persist.js';

/**
 * The signer's own material, as the keyring on this device holds it.
 *
 * **STRUCTURAL, AND DELIBERATELY NOT THE KEYRING'S OWN TYPE.** The keyring
 * module reaches the wallet, and the wallet reaches a package that leaves a
 * page blank while it is still being evaluated. What composes a record has to
 * be loadable in a background thread that has no wallet in it at all, so it
 * takes the three values and knows nothing about where they were unsealed.
 */
export interface SignerMaterial {
  signingSecret: Hex;
  blinding: Hex;
  /**
   * WHICH VAULTS THIS SIGNER MAY ACT ON.
   *
   * Optional here because the keyring's own entry is optional: material sealed
   * before scopes were recorded has none. **It is not defaulted below and it is
   * not filled in with zeroes.** The scope is part of the leaf this signer's
   * membership is proven against, so a composed record carrying a scope the
   * leaf does not commit to produces a signer who cannot prove they are one,
   * from a device reporting itself healthy. The absence is refused instead.
   */
  scope?: Hex;
}

/**
 * The record this module composes.
 *
 * **THE SIGNER'S THREE AND THE TWO PATH FIELDS ARE ALWAYS PRESENT; THE
 * ACCOUNT'S HALF IS OPTIONAL, AND THAT IS THE TYPE STATING A PROPERTY RATHER
 * THAN DESCRIBING A GAP.** An approval needs the first group and nothing else,
 * so a device with no staged material composes a record that is complete for
 * what it is about to do.
 */
export type ComposedRecord =
  Pick<AccountPrivateState, SignerOnlyField | 'pinnedPath'> & Partial<AccountPrivateState>;

/**
 * The same record with everything that must not be written down taken out.
 *
 * **EVERY FIELD ON IT IS OPTIONAL, AND THAT IS THE HONEST SHAPE RATHER THAN A
 * LOOSE ONE.** What a device has staged depends on what it is part way through
 * doing, and a type asserting that all of it is present would be a type nothing
 * could produce - which is how a cast gets written, and a cast here is how the
 * five come back.
 */
export type StorableHalf = Omit<ComposedRecord, NeverPersistedField>;

/**
 * Where the account's half is kept between staging a call and proving it.
 *
 * **AN ARGUMENT AND NOT A CHOICE MADE HERE.** It has to be durable across a
 * proof of some minutes and a reload in the middle of one, it has to be
 * reachable from the thread a call is assembled on, and it must not become the
 * place the signer's three end up. Which store satisfies that is a decision
 * with costs on both sides, so it is asked for rather than picked - and the
 * type it is handed has already had the five removed, so a store cannot be
 * given them by this module even by mistake.
 *
 * Every method takes the contract address explicitly. A store that remembered
 * one would be a second copy of the field this file exists to stop inheriting.
 */
export interface AccountHalfStore {
  /** Whatever is filed, unexamined. Treated as untrusted bytes on the way in. */
  get(contractAddress: string, privateStateId: string): Promise<unknown>;
  set(contractAddress: string, privateStateId: string, half: StorableHalf): Promise<void>;
  remove(contractAddress: string, privateStateId: string): Promise<void>;
  /** Everything this device holds for one contract, and nothing beyond it. */
  clear(contractAddress: string): Promise<void>;
}

/**
 * What the signer's three become, as the circuit reads them.
 *
 * Refuses rather than substituting anything. Each of the three is thirty-two
 * bytes and each is part of the leaf the tree is asked about, so a value of the
 * wrong width and a value that is absent fail in the same place and produce the
 * same sentence from the circuit: that this person is not a signer. **The
 * refusals below are what turn that into a sentence naming the actual cause**,
 * on the device, before a proof and before a fee.
 */
export const signerHalfOf = (
  material: SignerMaterial,
): Pick<AccountPrivateState, SignerOnlyField> => {
  const width = (name: string, value: Hex | undefined, missing: string): Uint8Array => {
    if (value === undefined || value === '') throw new Error(missing);
    let bytes: Uint8Array;
    try {
      bytes = fromHex(value);
    } catch {
      throw new Error(
        `the ${name} saved for this company on this device is not readable as key material. ` +
          'Take the seat on this device again to replace it.',
      );
    }
    if (bytes.length !== 32) {
      throw new Error(
        `the ${name} saved for this company on this device is ${bytes.length} bytes and a ` +
          'signer\'s is thirty-two. Take the seat on this device again to replace it.',
      );
    }
    return bytes;
  };

  return {
    secretKey: width(
      'signing key',
      material.signingSecret,
      'this device holds no signing key for that company, so it cannot act as a signer on it. ' +
        'Take the seat on this device to put one here.',
    ),
    blinding: width(
      'blinding factor',
      material.blinding,
      'this device holds no blinding factor for that company. The factor is half of what ' +
        'proves this signer is on the account, and it cannot be recovered from anywhere else. ' +
        'Take the seat on this device again to replace it.',
    ),
    /*
     * **ABSENT IS REFUSED AND IS NOT READ AS "EVERY VAULT".** The value that
     * means every vault is a constant the contract defines and it is not thirty
     * two zero bytes; a record filled in with zeroes seats this signer under a
     * scope no leaf on the account commits to, and the only symptom is a
     * membership proof that fails on a device with nothing visibly wrong with
     * it. Material sealed before scopes were recorded is the case this catches.
     */
    scope: width(
      'vault scope',
      material.scope,
      'the key material saved for this company on this device was written before vault ' +
        'scopes were recorded, so it cannot say which vaults this signer may act on, and ' +
        'nothing converts it. A seat taken under a new invitation by another sign-in can act.',
    ),
  };
};

/**
 * The signer's material, for as long as a session lasts and no longer.
 *
 * **A MAP ON ONE THREAD. IT REACHES NO STORAGE INTERFACE OF ANY KIND**, which
 * is a property of this class rather than of how it happens to be used: there
 * is nothing here to configure, nothing to name a database, and no method that
 * writes. Whatever holds one of these must itself be something nothing
 * persists.
 *
 * Keyed by the id a call names its record with, because that is the only thing
 * the scheme ever asks with. Turning an account into that id belongs to
 * whoever is doing the handing over.
 */
export class SignerMaterialHeldInMemory {
  private readonly held = new Map<string, SignerMaterial>();

  /** Puts one account's material within reach of the calls this session makes. */
  hold(privateStateId: string, material: SignerMaterial): void {
    this.held.set(privateStateId, material);
  }

  /** Takes it back out. The company is locked; nothing on it can be signed. */
  release(privateStateId: string): void {
    this.held.delete(privateStateId);
  }

  /** Signing out, or a session ending. */
  releaseAll(): void {
    this.held.clear();
  }

  for(privateStateId: string): SignerMaterial | null {
    return this.held.get(privateStateId) ?? null;
  }
}

/** Where the signer's material is looked up, so a caller can supply any holder. */
export type SignerMaterialSource = (privateStateId: string) => SignerMaterial | null;

/**
 * The message a caller meets when the address has not been set.
 *
 * The scheme sets it before every read and write it makes, so meeting this
 * means a caller reached the store directly and skipped that step - which would
 * otherwise answer with whichever contract happened to be addressed last.
 */
export const NO_CONTRACT_ADDRESSED =
  'a company\'s call material was asked for before it was said which contract the call is ' +
  'against. Nothing has been read: answering would risk answering from another company.';

/**
 * **AND NO VALUE MAY BE WRITTEN THAT IS A COPY OF THE SIGNER'S OWN MATERIAL,
 * WHATEVER FIELD IT SITS UNDER.**
 *
 * The check above this one is about NAMES, and a name is what a list can hold.
 * **What a list cannot hold is a secret written under a name that is allowed.**
 * The account's asset blinding is thirty-two bytes and is meant to be written;
 * a record whose asset blinding IS the signing key therefore passes every check
 * that reads a list of names, and puts a signer's key into the store under a
 * heading nobody would think to look at.
 *
 * That is not a theoretical shape: it is the one change that was found to leave
 * every case written over this file green, which is why the answer is a refusal
 * in the product rather than another case in a test.
 *
 * This device COMPOSED the record, so it already holds the three values that
 * must not come back out of it, and comparing five short fields against three
 * costs nothing. **Where no material is held there is nothing to compare
 * against and the name check above stands alone**, which is the honest
 * behaviour rather than a refusal of a write nobody can check.
 */
export const refuseToWriteTheSignersOwnMaterial = (
  half: object,
  material: SignerMaterial | null,
): void => {
  if (material === null) return;
  const mine = new Set(
    [material.signingSecret, material.blinding, material.scope]
      .filter((hex): hex is Hex => hex !== undefined && hex !== '')
      .map((hex) => hex.toLowerCase()),
  );
  for (const [name, value] of Object.entries(half)) {
    if (!(value instanceof Uint8Array)) continue;
    if (!mine.has(toHex(value).toLowerCase())) continue;
    throw new Error(
      `saving what this company's last call staged, on this device, was about to write this ` +
        `signer's own key material to storage under the name "${name}". It lives once, in this ` +
        'device\'s keyring, and a second copy of it is a second person who can sign. Nothing ' +
        'has been written.',
    );
  }
};

export interface DerivedPrivateStateOptions {
  /** Where this session's signer material is held. Memory, and nothing else. */
  signerMaterial: SignerMaterialSource;
  /** Where the account's half is kept. The caller's decision, not this file's. */
  accountHalf: AccountHalfStore;
}

/**
 * Builds the scheme's private-state interface over the two sources.
 *
 * A plain object rather than a class extending the package's, for the same
 * reason the sibling adapters here are: nothing in this file imports that
 * package at run time, so loading it pulls in no WebAssembly at all.
 */
export const derivedPrivateState = (
  options: DerivedPrivateStateOptions,
): PrivateStateProvider<string, ComposedRecord> => {
  let contractAddress: string | null = null;

  const addressed = (): string => {
    if (contractAddress === null) throw new Error(NO_CONTRACT_ADDRESSED);
    return contractAddress;
  };

  /**
   * What no store's answer may contribute, whatever it contains.
   *
   * The two path fields are set from constants here and not merged from
   * anywhere, and the signer's three are spread LAST so that even an answer
   * that somehow still carried one could not be the value a circuit reads.
   * Neither of those is the primary defence - the strip above them is - and
   * both are here because the primary defence is one function call away from
   * being edited by somebody who does not know what it holds up.
   */
  const compose = (stored: unknown, material: SignerMaterial): ComposedRecord => ({
    /*
     * The one cast in this file, and it is at the boundary it belongs at: what
     * a store hands back is bytes somebody else may have written, so it is
     * named as a record's shape and then immediately stripped, rather than
     * trusted as one.
     */
    ...persistableAccountHalf((stored ?? {}) as Partial<AccountPrivateState>),
    pinnedPath: null,
    ...signerHalfOf(material),
  });

  const refuse = (what: string, instead: string) => async (): Promise<never> => {
    throw new Error(
      `${what} is not something this device can do with a company's call material. ` +
        `${instead}`,
    );
  };

  return {
    setContractAddress(address) {
      contractAddress = address;
    },

    /**
     * The record for one call, composed at the moment it is asked for.
     *
     * **`null` MEANS THIS DEVICE HOLDS NO SEAT ON THAT ACCOUNT**, and it is the
     * honest answer rather than a composed record with nothing in it: the
     * scheme turns it into a refusal naming the record it looked for, which is
     * a sentence a reader can act on. A record composed from no material would
     * instead run the circuit against values that prove nothing and fail inside
     * it, naming none of this.
     */
    async get(privateStateId) {
      const address = addressed();
      const material = options.signerMaterial(privateStateId);
      if (material === null) return null;
      return compose(await options.accountHalf.get(address, privateStateId), material);
    },

    /**
     * Keeps the account's half and drops everything else.
     *
     * **THE REFUSAL HERE IS A CONTROL AND NOT A GUARD.** What removes the five
     * is the line above it; this one can only fire if that line has stopped
     * removing them, which is exactly the change that would otherwise ship
     * silently and be discovered as a signing key in a database.
     */
    async set(privateStateId, state) {
      const address = addressed();
      const half = persistableAccountHalf(state);
      refuseToPersistWhatMustNotBeStored(
        half,
        'saving what this company\'s last call staged, on this device',
      );
      refuseToWriteTheSignersOwnMaterial(half, options.signerMaterial(privateStateId));
      await options.accountHalf.set(address, privateStateId, half);
    },

    async remove(privateStateId) {
      await options.accountHalf.remove(addressed(), privateStateId);
    },

    /**
     * **THE ADDRESSED COMPANY'S HALF, AND NOT EVERY COMPANY'S, WHICH IS A
     * NARROWER ANSWER THAN THE INTERFACE'S NAME SUGGESTS.**
     *
     * The scheme describes this as removing every private state it holds. What
     * a device keeps here is per company and is reached per company, and a
     * caller that has named one company is a caller talking about that one. So
     * this clears the company that was named and refuses when none was, rather
     * than reaching across companies the caller did not mention. **Nothing in
     * the scheme calls it**, so what this is is a statement of what a caller
     * here would get rather than a behaviour anything depends on.
     */
    async clear() {
      await options.accountHalf.clear(addressed());
    },

    /*
     * ---- THE FOUR BELOW ARE REFUSALS, AND EACH ONE SAYS WHY ----------------
     *
     * **THE SIGNING KEY THIS INTERFACE MEANS IS NOT A SIGNER'S.** It is the key
     * that authorises MAINTENANCE of a deployed contract, and it is read and
     * written on three paths only: deploying, changing a contract's verifier
     * keys, and handing that authority to somebody else. **None of the three is
     * something a person's browser does here**, and a device that kept one
     * would be a second durable place key material lives that nothing in this
     * design has accounted for. Refusing names the operation rather than
     * failing later inside it.
     */
    setSigningKey: refuse(
      'giving this device authority to maintain a company\'s contract',
      'Maintenance is not done from a browser here, so nothing has been saved.',
    ),
    getSigningKey: refuse(
      'reading a contract maintenance authority from this device',
      'This device never holds one, so there is nothing to read.',
    ),
    removeSigningKey: refuse(
      'removing a contract maintenance authority from this device',
      'This device never holds one, so there is nothing to remove.',
    ),
    clearSigningKeys: refuse(
      'clearing contract maintenance authorities from this device',
      'This device never holds any, so there is nothing to clear.',
    ),

    /*
     * ---- AND THE FOUR THAT MOVE RECORDS BETWEEN MACHINES -------------------
     *
     * **AN EXPORT OF A COMPOSED RECORD IS AN EXPORT OF A SIGNING KEY**, because
     * composing is what a read here does - so the one operation this whole file
     * exists to make impossible is available, in a single call, to anything
     * holding this object. And an IMPORT is the other direction of the same
     * hazard: a record arriving from elsewhere is a record somebody else chose
     * the contents of, including the two fields that forge a membership path.
     *
     * Nothing in this product calls any of the four. They are refused rather
     * than left unimplemented so that the day something does, it is told why
     * instead of receiving a record.
     */
    exportPrivateStates: refuse(
      'copying a company\'s call material off this device',
      'It contains this signer\'s own key, which exists in one place on purpose and is ' +
        'not copied out. Nothing has been written or sent.',
    ),
    importPrivateStates: refuse(
      'loading a company\'s call material from somewhere else',
      'The signer\'s own key is read from this device\'s keyring at the moment it is ' +
        'needed, and the rest is staged by the call that needs it. Nothing has been saved.',
    ),
    exportSigningKeys: refuse(
      'copying contract maintenance authorities off this device',
      'This device never holds any, so there is nothing to copy.',
    ),
    importSigningKeys: refuse(
      'loading contract maintenance authorities onto this device',
      'Maintenance is not done from a browser here, so nothing has been saved.',
    ),
  };
};
