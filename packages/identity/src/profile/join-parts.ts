/**
 * **THE PUBLIC PARTS A JOIN CODE CARRIES** (`join-code.ts`), and the one reader
 * of them: a signer's seat keys and leaf, or a payee's address and payslip
 * key, exactly, and nothing else. Kept apart from the signing so a page that
 * only reads an ask carries none of it.
 */
const HEX64 = /^[0-9a-f]{64}$/u;
const ADDRESS = /^[\x21-\x7e]{40,200}$/u;

/** A signer's public parts: their seat's keys and leaf, made on their own device. */
export interface SignerParts {
  readonly kind: 'signer';
  readonly signingPublicKey: string;
  readonly wrappingPublicKey: string;
  readonly leafCommitment: string;
}

/** A payee's public parts: where they are paid, and the key their payslips are sealed to. */
export interface PayeeParts {
  readonly kind: 'payee';
  readonly address: string;
  readonly payslipKey: string;
}

export type JoinParts = SignerParts | PayeeParts;

/** The parts read whole, or null when they are not one of the two kinds exactly. */
export function readJoinParts(value: unknown): JoinParts | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(',');
  if (p.kind === 'signer' && keys === 'kind,leafCommitment,signingPublicKey,wrappingPublicKey'
    && [p.signingPublicKey, p.wrappingPublicKey, p.leafCommitment].every((k) => typeof k === 'string' && HEX64.test(k))) {
    return Object.freeze({ kind: 'signer', signingPublicKey: p.signingPublicKey as string, wrappingPublicKey: p.wrappingPublicKey as string, leafCommitment: p.leafCommitment as string });
  }
  if (p.kind === 'payee' && keys === 'address,kind,payslipKey'
    && typeof p.address === 'string' && ADDRESS.test(p.address) && typeof p.payslipKey === 'string' && HEX64.test(p.payslipKey)) {
    return Object.freeze({ kind: 'payee', address: p.address, payslipKey: p.payslipKey });
  }
  return null;
}

