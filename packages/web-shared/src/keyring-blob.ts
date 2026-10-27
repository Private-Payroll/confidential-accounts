/**
 * WHAT A PERSON'S SAVED KEYS ARE, SEALED AND OPENED: the one definition of the keyring's format, read by the page and
 * by the person's wallet alike.
 *
 * The service holds the keyring sealed under a key only the person's wallet derives, and hands it back whenever it is
 * asked, so it can hand back an older copy. The sealed text therefore carries its own `counter`, one more on every
 * write, and a reader that remembers the highest counter it has opened, and which sealed copy it was
 * (`sealedDigestOf`), can tell an older or another copy from the newest. The service's own version number is outside
 * the seal and is never that evidence.
 *
 * Nothing here holds a key, reads a store or talks to the service: it seals what it is given and opens what it is
 * handed, and refuses saved keys whose counter is not a whole number. `metadataOf` gives the parts of a keyring that
 * open nothing, for a page that may not hold the secrets beside them, and `metadataFrom` reads them again on the page;
 * `seatsOf` and `servedKeysOpenedFrom` are what a wallet reads from the saved keys for a page, none of it a secret.
 */
import type { Inviter, SignedSeatInvitation } from '../../../src/core/invitation.js';
import type { DirectoryEntryStatement } from 'midnight-identity/profile/records-key';
import type { CommitteeKey } from '../../../src/midnight/seat-directory.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { fromHex, seal, signingPublicKeyOf, toHex, unseal, unwrapKey, utf8, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { inboxPublicKey } from '../../../src/core/sealed-records.js';
import type { SeatOpening } from '../../../src/core/seat-opening.js';
import type { SealedAccount } from '../../../src/core/types.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';

export interface AccountKeys {
  signerId: string;
  signingSecret: Hex;
  wrappingSecret: Hex;
  /**
   * Hides this signer in the on-chain signer tree. As precious as the signing
   * key: without it the signer cannot reproduce their leaf and cannot prove
   * membership on the contract, even holding a valid key. Recovery has to
   * restore this too.
   */
  blinding: Hex;
  /**
   * **THE LEAF'S THIRD ARGUMENT, ON THE DEVICE AND NOT ON THE ROSTER.**
   *
   *
   * The circuit reads the scope from the DEVICE's private state
   * (`signerScope()`, a witness over `AccountPrivateState.scope`), so this is
   * the client's copy of the same thing and it belongs beside the blinding.
   * Putting it on the seat instead would tell the server which vault a signer
   * is scoped to, which is exactly the partition of the signer set the leaf's
   * blinding exists to hide.
   *
   * **REQUIRED, AND AN ENTRY SAVED WITHOUT ONE IS REFUSED BY NAME.** Key
   * material saved before scopes were recorded has none. Reading that absence
   * as any value - the scheme's own "every vault", or thirty-two zero bytes -
   * would be this page deciding a seat's leaf for it, and a wrong guess is a
   * signer who cannot prove they are one on a device that looks healthy. So
   * such an entry is not handed out at all: `keysFor` refuses it, and says the
   * seat has to be taken on this device again. Nothing converts one.
   */
  scope: Hex;
  /**
   * **THE SEAT THAT INVITED THIS SIGNER: ITS COMMITTEE KEY AND THE DIRECTORY
   * ENTRY ITS WALLET SIGNED**, as the invitation carried it. Handed to this
   * person's wallet on their first records-key ask for the company, which keeps
   * no account for a company it did not create until the person confirms it
   * against the inviter's. Absent for a seat taken without an invitation.
   */
  invitedBy?: Inviter;
  /**
   * **WHO THE SEAT IS FOR, AS THE SEAT THAT INVITED SIGNED IT**, kept from the
   * invitation this person accepted until their own directory entry carries it,
   * which every member's device holds it to. Absent for the founding seat and
   * for a seat added from a code.
   */
  invited?: SignedSeatInvitation;
  /**
   * **THIS SEAT'S OPENING OF ITS OWN LEAF**, made on this device when the seat
   * was taken: its public key on the account, scope and blinding, and the
   * wallet key and salt the blinding was made from. Carried in the seat's own
   * directory entry, which other devices believe only through it. Absent for a
   * seat taken on a device that made none, whose entry is then never believed:
   * that seat is taken again.
   */
  opening?: SeatOpening;
}

/** An entry as a saved bundle may hold it: material saved before scopes were recorded has no scope. */
export type SavedAccountKeys = Omit<AccountKeys, 'scope'> & { scope?: unknown };

/**
 * **KEY MATERIAL THAT IS DURABLE BEFORE ITS LEAF IS PUBLISHED.**
 *
 * A leaf published before its material is sealed, followed by a refused bundle
 * write, seats a signer whose key material never survived - a seat that counts
 * towards N and can never approve, which is the state `ownLeafReading` detects.
 *
 * So the material is sealed HERE first, under the
 * account it is for, and only then does a leaf leave the machine. The entry
 * carries no `signerId` because the server has not assigned one yet, and
 * `signingPublicKey` is what
 * matches it back to a seat on the roster afterwards.
 */
export interface PendingSeat {
  /** Which account this seat is on. The key of the map is not this. */
  accountId: string;
  signingPublicKey: Hex;
  signingSecret: Hex;
  wrappingSecret: Hex;
  blinding: Hex;
  scope: Hex;
  /** The seat that invited this signer, as the invitation carried it; promoted with the material. */
  invitedBy?: Inviter;
  /** This seat's opening of its own leaf, made here with the leaf; promoted with the material. */
  opening?: SeatOpening;
  /** Who the seat is for, as the seat that invited signed it; promoted with the material and carried into the seat's own entry. */
  invited?: SignedSeatInvitation;
}

/**
 * A KEYRING IS NOT A VAULT. A vault is what money moves through; a keyring holds only the keys that OPEN things,
 * one entry per account.
 *
 * Signing up makes a keyring and no vault: a person who has signed up holds no money. Vaults are made later, and
 * one person can be associated with several: their own payee address, and one per company they are a signer on.
 */
export interface Keyring {
  /** Keyed by account id. As saved, so an entry may predate scopes; on the page, `keysFor` is the only way one is handed out. */
  accounts: Record<string, SavedAccountKeys>;
  /**
   * **KEYED BY SIGNING PUBLIC KEY, NOT BY ACCOUNT**, and normally empty.
   *
   *
   * An entry here is key material this device sealed BEFORE publishing the leaf
   * it makes, and it survives until the seat it belongs to is on the roster and
   * has been promoted into `accounts`.
   *
   * **KEYED BY THE KEY BECAUSE KEYING BY ACCOUNT DESTROYS MATERIAL.** If a
   * POST succeeds and the promotion then fails, an entry here holds the ONLY
   * copy of the blinding for a leaf that is already on a roster. Under an
   * account-keyed map a second accepted invite for the same account overwrites
   * it, and that loses the material for good, made by the fix for
   * A signing public key is unique per seat and is the one half of this
   * material the server was given, so it names the seat without naming a
   * secret.
   *
   * **Optional, because an older bundle has no such field** and
   * `JSON.parse` of one must keep working.
   */
  pendingSeats?: Record<string, PendingSeat>;
  /**
   * **THE COMPANIES THAT PAY THIS PERSON, BY THEIR PUBLIC CONTRACT ADDRESS.**
   *
   * Kept here, sealed with everything else, because the service must not hold
   * in a form it can read which signed-in person is paid by which company. It
   * holds nothing that opens anything: the key that opens a payslip is worked
   * out from the wallet each time.
   *
   * **Optional, because saved keys written before it have no such field** and
   * `JSON.parse` of them must keep working.
   */
  paidBy?: string[];
  /**
   * **EVERY COMPANY THIS PERSON HAS STARTED ON A CHAIN AND NOT FINISHED**, keyed by the company, any number at once.
   * Each is kept on its own and finished, started again, set aside or taken up on its own. One that was started again
   * after its deploy was signed or sent is kept with `setAside: true` (not deleted: its deploy may still turn up on
   * the chain). Optional, because saved keys written before it have no such field.
   */
  creations?: Record<string, SavedCreation>;
  /**
   * **ONLY IN SAVED KEYS WRITTEN BEFORE EVERY CREATION WAS KEPT IN `creations`.** Such saved keys record a creation
   * set aside here. `creationsInOneRecord` folds each one into `creations` (marked `setAside`) when the keys are
   * read, and nothing writes this field.
   */
  creationsSetAside?: Record<string, SavedCreation>;
  /**
   * **THIS PERSON'S SIGNED DIRECTORY ENTRY FOR A COMPANY, UNTIL ITS DIRECTORY
   * HOLDS IT**, keyed by the company (`fileTheOwedDirectoryEntry`). Public
   * keys and a signature: nothing here opens anything. Optional, because saved
   * keys written before it have no such field.
   */
  directoryEntriesOwed?: Record<string, OwedDirectoryEntry>;
  /**
   * HOW MANY TIMES THESE SAVED KEYS HAVE BEEN WRITTEN, one more on every write (`sealKeyring`). Absent on saved keys
   * written before it was kept, which read as 0 (`counterOf`).
   */
  counter?: number;
}

/**
 * **WHAT IS KEPT OF A COMPANY THIS PERSON IS CREATING ON A CHAIN, UNTIL ITS
 * CREATION IS FINISHED**: with everything else they have saved, so a reload, a
 * closed tab or another of their browsers carries on from where it stopped and
 * never makes a second company of the same creation. Any number of creations are kept at once, each under its own company.
 *
 * Nothing here is a secret of the company: the request that made it is public
 * halves and what its secrets seal, the deploy and the second step are public
 * once sent, and the signature is the founding signer's on a public step. The
 * seat's own secrets are kept beside it as every seat's are.
 */
export interface SavedCreation {
  readonly accountId: string;
  /** The person who started it: every later write of it is refused when somebody else is signed in. Absent on a creation kept before it was recorded. */
  readonly person?: string;
  readonly label: CompanyLabel;
  readonly foundingKey: { readonly tag: 'schnorr'; readonly value: string };
  /** The request that made the company, exactly as sent: sent again, it is the same company. */
  readonly request: {
    readonly name: string;
    readonly signers: ReadonlyArray<{ readonly name: string; readonly role: 'admin' | 'approver' | 'initiator' | 'viewer' }>;
    readonly threshold: number;
    readonly companyLabel: CompanyLabel;
    readonly foundingKey: { readonly tag: 'schnorr'; readonly value: string };
    /**
     * What founding the company made: the founding seat's public halves and leaf, and the company's record, first
     * roster and first state, sealed. The same shape `foundTheCompanyHere` returns.
     */
    readonly founding: {
      readonly seat: {
        readonly signerId: string;
        readonly signingPublicKey: Hex;
        readonly wrappingPublicKey: Hex;
        readonly leaf: Hex;
      };
      readonly account: SealedAccount;
      readonly roster: SealedCompanyRecord;
      readonly state: SealedCompanyRecord;
    };
  };
  /** The service answered the request: the company exists. */
  readonly made: boolean;
  /** The account's deploy, built here, and the keys its second step adds. */
  readonly deploy: {
    readonly account: AccountAddress; readonly tx: string; readonly insert: ReadonlyArray<{ circuit: string; key: string }>;
    /** When it was built (epoch ms, taken before it was built): its time to live runs from there. Absent on one kept before this was kept. */
    readonly builtAt?: number;
  } | null;
  /** The second step, signed by the founding signer's wallet, and that signature. */
  readonly signed: {
    readonly tx: string; readonly signature: { readonly tag: string; readonly value: string };
    /** When it was built, as for the deploy. */
    readonly builtAt?: number;
  } | null;
  /** The service recorded the deploy and the second step. */
  readonly recorded: boolean;
  /**
   * The service refused a step for the life it had left, so what is kept is built again before it is next sent, whatever
   * this device's clock says of its age: the service reads the step's own time to live, which this device cannot.
   */
  readonly mustBeBuiltAgain?: true;
  /** Set when this creation was started again after its deploy was signed or sent: kept, not listed as being finished, and taken up if its account turns up. */
  readonly setAside?: true;
}

const howFarOn = (c: SavedCreation): number => (c.recorded ? 4 : 0) + (c.signed !== null ? 2 : 0) + (c.deploy !== null ? 1 : 0);

/**
 * Saved keys written before every creation was kept in `creations` hold the ones set aside in `creationsSetAside`.
 * Read into the new shape, each is a creation of its own marked `setAside`; none is lost. If the same company is in both,
 * the one further on is kept.
 */
export function creationsInOneRecord(k: Keyring): Keyring {
  const { creationsSetAside, ...rest } = k;
  if (creationsSetAside === undefined || creationsSetAside === null || typeof creationsSetAside !== 'object') return k;
  const creations: Record<string, SavedCreation> = { ...(rest.creations ?? {}) };
  for (const [id, aside] of Object.entries(creationsSetAside)) {
    const active = creations[id];
    if (active === undefined) creations[id] = { ...aside, setAside: true };
    else if (howFarOn(aside) > howFarOn(active)) {
      const { setAside: _flag, ...asActive } = aside;
      creations[id] = asActive;
    }
  }
  return { ...rest, creations };
}

/**
 * A directory entry this signer's own wallet signed, kept on their device until
 * the company's directory holds it, with the seat's opening made when the seat
 * was taken on this device.
 */
export interface OwedDirectoryEntry {
  /** The signed-in person the entry names: only they may file it. */
  readonly person: string;
  readonly company: CompanyLabel;
  readonly signed: { readonly committeeKey: CommitteeKey; readonly entry: DirectoryEntryStatement };
  /** Absent where the seat was taken on a device that made no opening: such an entry is never filed. */
  readonly opening?: SeatOpening;
  /**
   * Who the seat is for, as the seat that invited signed it, kept from the
   * invitation this device accepted. It names no leaf, so the entry carries
   * the one the proposal that seated it holds; absent for the founding seat
   * and for a seat added from a code.
   */
  readonly invited?: SignedSeatInvitation;
}


/** Saved keys that could not be read: not opened by the key given, not a keyring, or a counter that is not a count. */
export class KeyringDidNotOpen extends Error {
  constructor(says: string) {
    super(says);
    this.name = 'KeyringDidNotOpen';
  }
}

/**
 * HOW MANY TIMES THESE SAVED KEYS HAVE BEEN WRITTEN, as their own sealed text says. Saved keys written before the
 * count was kept carry none and read as 0, so the first write of them is 1. Anything else that is not a whole number
 * from 0 is refused rather than read as some count: a guessed count is how an older copy would pass for a newer one.
 */
export function counterOf(k: Keyring): number {
  const counter = (k as { readonly counter?: unknown }).counter;
  if (counter === undefined) return 0;
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) {
    throw new KeyringDidNotOpen('these saved keys say how many times they were written in a way that is not a count, so they are not read.');
  }
  return counter;
}

/**
 * OPENS SAVED KEYS WITH THE KEY THEY WERE SEALED UNDER, into the keyring as it is used now. Refuses, with
 * `KeyringDidNotOpen`, saved keys the key does not open, text that is not a keyring, and a counter that is not a count.
 * It trusts nothing about which copy this is: whether it is the newest is for the reader that remembers counters.
 */
export function openKeyring(sealed: Sealed, key: Hex): Keyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unseal(sealed, key));
  } catch {
    throw new KeyringDidNotOpen('these saved keys did not open with this key.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KeyringDidNotOpen('these saved keys opened to something that is not a keyring.');
  }
  const k = parsed as Keyring;
  if (typeof k.accounts !== 'object' || k.accounts === null || Array.isArray(k.accounts)) {
    throw new KeyringDidNotOpen('these saved keys opened to something that is not a keyring.');
  }
  counterOf(k);
  return creationsInOneRecord(k);
}

/**
 * SEALS THE NEXT WRITE OF A KEYRING: `next` as it should be kept, its counter one more than the keyring it was made
 * from. Returns the sealed text for the service and the keyring as written, counter included, for the writer to hold.
 */
export function sealKeyring(next: Keyring, key: Hex): { readonly sealed: Sealed; readonly written: Keyring } {
  const { rostersBelieved: _noLongerKept, ...rest } = next as Keyring & { readonly rostersBelieved?: unknown };
  const written: Keyring = { ...rest, counter: counterOf(next) + 1 };
  return { sealed: seal(JSON.stringify(written), key), written };
}

/**
 * WHICH SEALED COPY THIS IS: a hash of the sealed text exactly as kept. Two copies sealed at the same count from one
 * keyring differ here, so a reader that remembers the copy it saw at a count can refuse the other.
 */
export function sealedDigestOf(sealed: Sealed): Hex {
  return toHex(sha256(utf8(`${sealed.iv}:${sealed.tag}:${sealed.body}`)));
}

/** A company this person is creating, kept in their saved keys, unless it was set aside. */
export function creationIn(k: Keyring, accountId: string): SavedCreation | undefined {
  const c = k.creations?.[accountId];
  return c !== undefined && c.setAside !== true ? c : undefined;
}

/** The keyring with this creation kept under its company, replacing whatever was kept there. */
export function withCreation(k: Keyring, c: SavedCreation): Keyring {
  return { ...k, creations: { ...(k.creations ?? {}), [c.accountId]: c } };
}

/** The keyring with nothing kept of a creation under this company. */
export function withoutCreation(k: Keyring, accountId: string): Keyring {
  const { [accountId]: _done, ...rest } = k.creations ?? {};
  return { ...k, creations: rest };
}

/**
 * The keyring holding a seat on a company it held no seat on. Refuses a company it already holds keys for: writing over
 * them would lose the only copy of a seat's secrets.
 */
export function withNewSeat(k: Keyring, accountId: string, keys: AccountKeys): Keyring {
  if (Object.prototype.hasOwnProperty.call(k.accounts, accountId)) {
    throw new Error('these saved keys already hold a seat on this company, so a new one is not written over it. Nothing was changed.');
  }
  return { ...k, accounts: { ...k.accounts, [accountId]: keys } };
}

/** The keyring owing this company's directory the entry given: it replaces one owed before, which a newer signing supersedes. */
export function withOwedEntry(k: Keyring, accountId: string, owed: OwedDirectoryEntry): Keyring {
  return { ...k, directoryEntriesOwed: { ...(k.directoryEntriesOwed ?? {}), [accountId]: owed } };
}

/** The keyring owing this company's directory nothing more, once its entry is filed or found there. */
export function withoutOwedEntry(k: Keyring, accountId: string): Keyring {
  const { [accountId]: _filed, ...rest } = k.directoryEntriesOwed ?? {};
  return { ...k, directoryEntriesOwed: rest };
}

/** A directory entry still owed, without the seat's opening of its leaf, which only the seat's own wallet holds. */
type OwedEntryShown = Omit<OwedDirectoryEntry, 'opening'>;

/**
 * **THE PARTS OF SAVED KEYS THAT OPEN NOTHING**, which a page lists and acts on with no window: the companies being
 * created and how far each is, the companies that pay this person, the directory entries still owed, and the seats
 * sealed before their leaves were published, by account and public key. Built field by field from what may be shown,
 * never by removing what may not, so a field added to the keyring later stays out until it is added here.
 */
export interface KeyringMetadata {
  readonly counter: number;
  readonly creations: Readonly<Record<string, SavedCreation>>;
  readonly paidBy: readonly string[];
  readonly directoryEntriesOwed: Readonly<Record<string, Omit<OwedDirectoryEntry, 'opening'>>>;
  readonly pendingSeats: ReadonlyArray<{ readonly accountId: string; readonly signingPublicKey: Hex }>;
}

/*
 * **WHAT MAY BE SHOWN, FIELD BY FIELD, AT EVERY DEPTH.** A shape names each field that may be copied: `V` for a plain
 * value (a string, a number, a boolean or null; anything else in its place is dropped), an object of shapes for a
 * nested record, and `[shape]` for a list of them. A field the shape does not name is not copied, at any depth.
 */
type Shape = 'value' | { readonly [field: string]: Shape } | readonly [Shape];
const V = 'value' as const;
const SEALED: Shape = { iv: V, tag: V, body: V };
const WRAPPED: Shape = { iv: V, tag: V, body: V, ephemeral: V };
const SCHNORR: Shape = { tag: V, value: V };
const COMPANY_RECORD: Shape = {
  company: V, kind: V, id: V, version: V, keyEpoch: V, sealed: SEALED,
  wrapped: [{ signerId: V, wrapped: WRAPPED }],
  facts: { status: V },
  filedBy: { publicKey: V, signature: V },
};
const CREATION: Shape = {
  accountId: V, person: V, label: V, foundingKey: SCHNORR,
  request: {
    name: V, signers: [{ name: V, role: V }], threshold: V, companyLabel: V, foundingKey: SCHNORR,
    founding: {
      seat: { signerId: V, signingPublicKey: V, wrappingPublicKey: V, leaf: V },
      account: {
        id: V, createdAt: V, keyEpoch: V, signerCount: V, memberUserIds: [V],
        pendingSigners: [{ id: V, userId: V, createdAt: V, sealed: WRAPPED }],
        wrappedKeys: [{ iv: V, tag: V, body: V, signerId: V, ephemeral: V }],
        inboxPublicKey: V, sealedRoster: SEALED, sealedPolicy: SEALED, contractAddress: V, addressSource: V, companyLabel: V,
        wiring: V,
      },
      roster: COMPANY_RECORD,
      state: COMPANY_RECORD,
    },
  },
  made: V,
  deploy: { account: V, tx: V, insert: [{ circuit: V, key: V }], builtAt: V },
  signed: { tx: V, signature: SCHNORR, builtAt: V },
  recorded: V, mustBeBuiltAgain: V, setAside: V,
};
const OWED: Shape = {
  person: V, company: V,
  signed: { committeeKey: SCHNORR, entry: { account: V, signingKey: V, wrappingKey: V, seat: V, signature: V } },
  invited: {
    terms: {
      company: V, invitation: V, person: V, name: V, role: V, leaf: V,
      replaces: { invitation: V, signedBy: V, signature: V },
    },
    signedBy: V, signature: V,
  },
};

/** `value` copied as `shape` allows, or undefined where it allows nothing. Null is kept wherever it stands. */
function shown(value: unknown, shape: Shape): unknown {
  if (value === null) return null;
  if (shape === V) return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((x) => shown(x, shape[0] as Shape)).filter((x) => x !== undefined) : undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(shape as Readonly<Record<string, Shape>>)) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const copied = shown((value as Record<string, unknown>)[field], inner);
    if (copied !== undefined) out[field] = copied;
  }
  return out;
}

const creationShown = (c: SavedCreation): SavedCreation => shown(c, CREATION) as SavedCreation;
const owedShown = (o: OwedDirectoryEntry): OwedEntryShown => shown(o, OWED) as OwedEntryShown;

/** The parts of these saved keys that open nothing; see `KeyringMetadata`. */
export function metadataOf(k: Keyring): KeyringMetadata {
  const creations: Record<string, SavedCreation> = {};
  for (const [id, c] of Object.entries(k.creations ?? {})) creations[id] = creationShown(c);
  const owed: Record<string, OwedEntryShown> = {};
  for (const [id, o] of Object.entries(k.directoryEntriesOwed ?? {})) owed[id] = owedShown(o);
  return {
    counter: counterOf(k),
    creations,
    paidBy: [...(k.paidBy ?? [])].filter((x): x is string => typeof x === 'string'),
    directoryEntriesOwed: owed,
    pendingSeats: Object.values(k.pendingSeats ?? {}).map((s) => ({ accountId: s.accountId, signingPublicKey: s.signingPublicKey })),
  };
}

/**
 * **THE METADATA AGAIN, FROM WHAT A WALLET SAID**: the page reads what a wallet answered through the same allow-list
 * the wallet built it with, so a field the list does not name never reaches the page's memory, whoever answered.
 */
export function metadataFrom(value: unknown): KeyringMetadata {
  const v = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const counter = typeof v['counter'] === 'number' && Number.isSafeInteger(v['counter']) && (v['counter'] as number) >= 0 ? v['counter'] as number : 0;
  const creations: Record<string, SavedCreation> = {};
  const c = v['creations'];
  if (typeof c === 'object' && c !== null && !Array.isArray(c)) {
    for (const [id, one] of Object.entries(c)) {
      const shownOne = shown(one, CREATION);
      if (typeof shownOne === 'object' && shownOne !== null && (shownOne as { accountId?: unknown }).accountId === id) creations[id] = shownOne as SavedCreation;
    }
  }
  const owed: Record<string, OwedEntryShown> = {};
  const o = v['directoryEntriesOwed'];
  if (typeof o === 'object' && o !== null && !Array.isArray(o)) {
    for (const [id, one] of Object.entries(o)) {
      const shownOne = shown(one, OWED);
      if (typeof shownOne === 'object' && shownOne !== null) owed[id] = shownOne as OwedEntryShown;
    }
  }
  const paidBy = Array.isArray(v['paidBy']) ? (v['paidBy'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const pendingSeats = Array.isArray(v['pendingSeats'])
    ? (v['pendingSeats'] as unknown[]).map((p) => shown(p, { accountId: V, signingPublicKey: V }) as { accountId: string; signingPublicKey: Hex })
      .filter((p) => typeof p?.accountId === 'string' && typeof p?.signingPublicKey === 'string')
    : [];
  return { counter, creations, paidBy, directoryEntriesOwed: owed, pendingSeats };
}

/** A seat's public halves and scope, by company id: what a page may know of each seat the saved keys hold. */
export interface SeatPublicHalves {
  readonly signerId: string;
  readonly signingPublicKey: Hex;
  readonly wrappingPublicKey: Hex;
  readonly scope: Hex;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** Every held seat's public halves and scope. A seat saved before scopes were kept is left out: it acts on nothing here. */
export function seatsOf(k: Keyring): Record<string, SeatPublicHalves> {
  const out: Record<string, SeatPublicHalves> = {};
  for (const [id, seat] of Object.entries(k.accounts)) {
    const scope = typeof seat.scope === 'string' ? seat.scope.toLowerCase() : '';
    if (!HEX64.test(scope) || typeof seat.signerId !== 'string') continue;
    out[id] = Object.freeze({
      signerId: seat.signerId,
      signingPublicKey: signingPublicKeyOf(seat.signingSecret).toLowerCase(),
      wrappingPublicKey: toHex(x25519.getPublicKey(fromHex(seat.wrappingSecret))).toLowerCase(),
      scope,
    });
  }
  return out;
}

/** One company's viewing key wrapped to its seats as the service holds it, with the company's inbox public key. */
export interface ServedKeys {
  readonly accountId: string;
  readonly inboxPublicKey: string;
  readonly wrappedKeys: ReadonlyArray<{ readonly signerId: string; readonly iv: string; readonly tag: string; readonly body: string; readonly ephemeral: string }>;
}

/**
 * **EACH COMPANY'S VIEWING KEY, OPENED WITH THE SEAT'S WRAPPING SECRET AND GIVEN ONLY WHEN IT MAKES THE COMPANY'S
 * INBOX PUBLIC KEY.** Much else is wrapped to a seat's wrapping key (vault keys offers, pay and run keys, policies);
 * a key that does not make the inbox key handed beside it is not this company's viewing key, so it is not given, and
 * the page cannot have the wallet open anything else for it. A company whose seat this keyring does not hold, or
 * whose key does not open, is left out.
 */
export function servedKeysOpenedFrom(k: Keyring, served: readonly ServedKeys[]): Record<string, Hex> {
  const out: Record<string, Hex> = {};
  for (const s of served) {
    const seat = Object.prototype.hasOwnProperty.call(k.accounts, s.accountId) ? k.accounts[s.accountId] : undefined;
    if (seat === undefined) continue;
    const wrapped = s.wrappedKeys.find((w) => w.signerId === seat.signerId);
    if (wrapped === undefined) continue;
    let key: string;
    try { key = unwrapKey(wrapped, seat.wrappingSecret).toLowerCase(); } catch { continue; }
    if (!HEX64.test(key)) continue;
    if (inboxPublicKey(key, s.accountId).toLowerCase() !== s.inboxPublicKey.toLowerCase()) continue;
    out[s.accountId] = key;
  }
  return out;
}

/** A change to one creation the page asks for. */
interface CreationTidy {
  readonly record: string;
  readonly what: 'aside' | 'forget';
}

/**
 * **THE PAGE'S ASKED CHANGES TO CREATIONS, MADE ONLY WHERE THE SAVED KEYS AGREE.** Setting a creation aside keeps all
 * of it, flagged, and an action on the chain takes it up again, so it loses nothing. Dropping one is done only when
 * nothing was signed or recorded for it, so nothing the chain may still hold is forgotten. Anything else asked is
 * left as it was. Returns the keyring unchanged (the same object) when nothing changed.
 */
export function tidiedWith(k: Keyring, tidy: readonly CreationTidy[]): Keyring {
  let next = k;
  for (const t of tidy) {
    const c = next.creations?.[t.record];
    if (c === undefined) continue;
    if (t.what === 'aside' && c.setAside !== true) {
      next = { ...next, creations: { ...(next.creations ?? {}), [t.record]: { ...c, setAside: true } } };
    } else if (t.what === 'forget' && c.signed === null && !c.recorded && c.setAside !== true) {
      next = withoutCreation(next, t.record);
    }
  }
  return next;
}
