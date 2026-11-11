/*
 * What is kept of a company this person is creating on a chain, until its creation is finished, and the reads and
 * writes of it in their saved keys.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../src/core/crypto.js';
import type { SealedAccount, SignerRole } from '../../../src/core/types.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { Keyring } from './keyring-blob.js';

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
    readonly signers: ReadonlyArray<{ readonly name: string; readonly role: SignerRole }>;
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
