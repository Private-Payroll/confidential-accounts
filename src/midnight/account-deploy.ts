/**
 * **A TRANSACTION THE COMPANY PAYS FOR, READ BEFORE IT IS PAID FOR, AND A
 * COMPANY'S ACCOUNT AS ITS FOUNDING SIGNER CREATED IT.**
 *
 * The reading every fee-only transaction starts from - one set of actions,
 * moving no coin - and the one reading of a company account's deploy: held by
 * its founding signer's key alone, this build's first circuits, starting with
 * nothing, and starting from exactly the state its constructor makes. The
 * service reads a deploy with it before it pays, and the founding signer's
 * wallet reads the same deploy with it before it keeps the account as the
 * company's, so the two can never disagree about what a company's account at
 * its start is.
 *
 * Pure, and loads no WebAssembly: the ledger's objects are handed in.
 */
import type { CommitteeKey } from './vault-committee.js';
import { sameCommittee } from './vault-committee.js';
import { circuitsRefusal, startsHoldingMoney } from './vault-circuits.js';

export const bare = (a: unknown): string => String(a).trim().toLowerCase().replace(/^0x/u, '');
export const nameOf = (entryPoint: unknown): string =>
  entryPoint instanceof Uint8Array ? new TextDecoder().decode(entryPoint) : String(entryPoint);

export const emptyOffer = (offer: unknown, parts: readonly string[]): boolean => {
  if (offer === undefined || offer === null) return true;
  if (typeof offer !== 'object') return false;
  return parts.every((k) => {
    const v = (offer as Record<string, unknown>)[k];
    return Array.isArray(v) && v.length === 0;
  });
};

export interface TxShape {
  intents?: unknown;
  guaranteedOffer?: unknown;
  fallibleOffer?: unknown;
}
export interface IntentShape {
  actions?: unknown;
  guaranteedUnshieldedOffer?: unknown;
  fallibleUnshieldedOffer?: unknown;
  dustActions?: unknown;
}

/** The one intent a fee-only transaction carries, or a refusal. */
export const theOnlyIntent = (tx: unknown, what: string): { intent: IntentShape } | { refusal: string } => {
  const t = tx as TxShape | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) {
    return { refusal: `this is not ${what}: it must carry exactly one set of actions. Nothing was sent.` };
  }
  if (!emptyOffer(t.guaranteedOffer, ['inputs', 'outputs', 'transients'])
    || (t.fallibleOffer !== undefined && t.fallibleOffer !== null
      && (!(t.fallibleOffer instanceof Map) || [...t.fallibleOffer.values()].some(
        (o) => !emptyOffer(o, ['inputs', 'outputs', 'transients']))))) {
    return { refusal: `this is not ${what}: it moves coins, and the company pays only for one that moves none. Nothing was sent.` };
  }
  const intent = [...t.intents.values()][0] as IntentShape | null;
  if (!intent || !emptyOffer(intent.guaranteedUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.fallibleUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return { refusal: `this is not ${what}: it moves coins, and the company pays only for one that moves none. Nothing was sent.` };
  }
  if (!Array.isArray(intent.actions) || intent.actions.length !== 1) {
    return { refusal: `this is not ${what}: it must do exactly one thing. Nothing was sent.` };
  }
  return { intent };
};

export type DeployVerdict = { readonly vault: string } | { readonly refusal: string };

/* ------------------------------------------------ 1a. a company's account, deployed from its founding signer's browser */

export interface AccountDeployExpectations {
  /** The founding signer's committee key, as recorded when the company was created, before anything was sent. */
  readonly foundingKey: CommitteeKey;
  /** The first step's circuits and their verifying keys, as this build compiled them. */
  readonly verifierKeys: ReadonlyMap<string, Uint8Array>;
  readonly circuits: readonly string[];
  /**
   * The whole state this service builds itself from what it recorded - the
   * constructor run over the founding signer's seat and the company's label,
   * this build's first circuits and the founding signer's key - serialized.
   */
  readonly expectedState: Uint8Array;
}

/**
 * **A COMPANY'S ACCOUNT, DEPLOYED BY ITS FOUNDING SIGNER'S DEVICE, AS THIS
 * SERVICE READS IT BEFORE IT PAYS.** One deploy and nothing else; held by the
 * founding signer's recorded key alone, at a threshold of one, never changed;
 * running exactly this build's first circuits; starting from exactly the state
 * the constructor makes from what this service recorded, compared byte for
 * byte, so no seat, proposal or field the roster does not show is written into
 * the account for good.
 */
export function readAccountDeploy(tx: unknown, expect: AccountDeployExpectations): DeployVerdict {
  const what = 'this company\'s account, as its founding signer created it';
  const only = theOnlyIntent(tx, what);
  if ('refusal' in only) return only;
  const deploy = (only.intent.actions as unknown[])[0] as { address?: unknown; initialState?: unknown; entryPoint?: unknown };
  if (deploy.initialState === undefined || deploy.address === undefined || deploy.entryPoint !== undefined) {
    return { refusal: `this is not ${what}: it does something other than deploy a contract. Nothing was sent.` };
  }
  const state = deploy.initialState as {
    maintenanceAuthority?: { committee?: unknown[]; threshold?: unknown; counter?: unknown };
    serialize?: () => Uint8Array;
  };
  const authority = state.maintenanceAuthority;
  const keys = Array.isArray(authority?.committee) ? (authority!.committee as CommitteeKey[]) : null;
  if (keys === null || typeof authority?.threshold !== 'number' || authority.counter !== 0n
    || !sameCommittee(
      { committee: keys.map((k) => ({ tag: String(k.tag), value: String(k.value).toLowerCase() })), threshold: authority.threshold },
      { committee: [{ tag: expect.foundingKey.tag, value: expect.foundingKey.value.toLowerCase() }], threshold: 1 })) {
    return {
      refusal: `this is not ${what}: a company's account is created held by its founding signer's own key alone, at a `
        + 'threshold of one and never changed, and this one carries another authority. Nothing was sent.',
    };
  }
  const money = startsHoldingMoney(state, `this is not ${what}`);
  if (money !== null) return { refusal: money };
  const circuits = circuitsRefusal(state, expect.verifierKeys, `this is not ${what}`, expect.circuits, 'the account\'s first step\'s');
  if (circuits !== null) return { refusal: circuits };
  let bytes: Uint8Array;
  try {
    bytes = state.serialize!();
  } catch {
    return { refusal: `this is not ${what}: its state cannot be read. Nothing was sent.` };
  }
  if (bytes.length !== expect.expectedState.length || bytes.some((b, i) => b !== expect.expectedState[i])) {
    return {
      refusal: `this is not ${what}: it starts from a state other than the one the account's constructor makes from `
        + 'the founding signer\'s seat and the company\'s label, so it would carry something nobody approved. Nothing was sent.',
    };
  }
  return { vault: bare(deploy.address) };
}

