/*
 * HOW EACH CALL THIS WALLET SENDS MOVES WHO HOLDS THE COMPANY, exactly as the company's account moves it when the call
 * lands, for a step to declare before it sends the call (`StepContext.movesWhoHolds`). Each move is the holders the call
 * leaves, from the holders read just before it: the seats, the account's threshold (`approvals`), the vaults adopted, each
 * vault's own threshold and the approvals a policy change needs. The kinds of proposal whose carrying out moves them are
 * one table (`CARRIED_BY`): the chain call each is carried out by, which the carry step declares the kind's move for.
 */
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { HoldersMove } from '../../../../packages/web-shared/src/company-view-probe.js';
import type { MovingSend } from './step-views.js';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/* A threshold of 0 is the account's word for "keep the one in force". */
const thresholdTo = (threshold: number): Partial<AccountHoldersRead> => (threshold === 0 ? {} : { approvals: threshold });

/* The approvals a policy change needs, raised to `most` and never lowered by it: a missing row reads as none. */
const barRaisedTo = (bar: number | null, most: number): number | null => ((bar ?? 0) < most ? most : bar);

/**
 * **THE KINDS OF PROPOSAL WHOSE CARRYING OUT MOVES WHO HOLDS THE COMPANY**, by the name the page gives them: the circuit
 * that carries each out on the chain, whether it is called on the company's account or on the vault, and where the
 * service is asked to send it first (the proposal's own carry written through the view, the vault's start route, or
 * nowhere: the wallet sends it straight).
 */
export const CARRIED_BY = {
  threshold: { circuit: 'setThreshold', on: 'account', service: 'proposal' },
  'vault-threshold': { circuit: 'setVaultThreshold', on: 'account', service: 'proposal' },
  removal: { circuit: 'removeSignerAndSetThreshold', on: 'account', service: 'proposal' },
  'spending-policy': { circuit: 'setPolicy', on: 'account', service: 'proposal' },
  'policy-bar': { circuit: 'setPolicyBar', on: 'account', service: 'proposal' },
  'adopt-vault': { circuit: 'adopt', on: 'account', service: 'vault-start' },
  'retire-vault': { circuit: 'retire', on: 'vault', service: null },
} as const satisfies Readonly<Record<string, { readonly circuit: string; readonly on: 'account' | 'vault'; readonly service: 'proposal' | 'vault-start' | null }>>;

/** A kind of proposal whose carrying out moves who holds the company. */
export type MovingKind = keyof typeof CARRIED_BY;

/** What carrying one proposal out moves: its kind, the move, and for a call made on a vault, that vault. */
export interface CarryMoves {
  readonly kind: MovingKind;
  readonly move: HoldersMove;
  readonly vault?: string;
}

/** The chain call that carries `moves` out: its kind's circuit, on the company's `account` or on the vault named. */
export const carriedCall = (moves: CarryMoves, account: string): { readonly circuit: string; readonly contract: string } => {
  const by = CARRIED_BY[moves.kind];
  if (by.on === 'vault' && moves.vault === undefined) throw new Error(`the carrying out of ${moves.kind} names no vault, so nothing was sent.`);
  return { circuit: by.circuit, contract: (by.on === 'account' ? account : moves.vault!).toLowerCase() };
};

/** Whether a call on the chain is one some kind of proposal is carried out by, so it moves who holds the company. */
export const movesWhoHoldsByCircuit = (circuit: string): boolean => Object.values(CARRIED_BY).some((by) => by.circuit === circuit);

/** The sends a carry's move is declared under before anything is sent: its write through the view, when the service is asked by one. */
export const carryWrites = (id: string, moves: CarryMoves): readonly MovingSend[] =>
  (CARRIED_BY[moves.kind].service === 'proposal' ? [{ proposal: id }] : []);

/** Taking an invited seat: the invitee's leaf seated, and the threshold the invitation sets, when it sets one. */
export const seated = (leaf: string, threshold: number): HoldersMove => (h) =>
  ({ ...h, seats: [...h.seats, leaf.toLowerCase()], ...thresholdTo(threshold) });

/** A removal: the leaf's seat emptied, and the threshold it leaves the company at, when it names one. */
export const removed = (leaf: string, threshold: number): HoldersMove => (h) =>
  ({ ...h, seats: h.seats.filter((s) => !same(s, leaf)), ...thresholdTo(threshold) });

/** A change of the account's threshold. */
export const thresholdSet = (threshold: number): HoldersMove => (h) => ({ ...h, approvals: threshold });

/** A vault's own threshold set, which raises the approvals a policy change needs to it. */
export const vaultThresholdSet = (vault: string, threshold: number): HoldersMove => (h) => ({
  ...h, policyBar: barRaisedTo(h.policyBar, threshold),
  vaultThresholds: [...h.vaultThresholds.filter((v) => !same(v.vault, vault)), { vault: vault.toLowerCase(), threshold }],
});

/** A change of the approvals a policy change needs. */
export const policyBarSet = (bar: number): HoldersMove => (h) => ({ ...h, policyBar: bar });

/** A spending policy set, which raises the approvals a policy change needs to its highest band's. */
export const policySet = (most: number): HoldersMove => (h) => ({ ...h, policyBar: barRaisedTo(h.policyBar, most) });

/** A vault retired by the account, which lets go of it. */
export const retired = (vault: string): HoldersMove => (h) => ({ ...h, adoptedVaults: h.adoptedVaults.filter((v) => !same(v, vault)) });

/** A vault adopted by the account. */
export const adopted = (vault: string): HoldersMove => (h) => ({ ...h, adoptedVaults: [...h.adoptedVaults, vault.toLowerCase()] });
