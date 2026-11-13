/**
 * **THE PUBLIC PARTS A JOIN CODE CARRIES** (`join-code.ts`), and the one reader
 * of them: a signer's seat keys and leaf, a payee's address and payslip key,
 * or a reader's key, exactly, and nothing else. Kept apart from the signing so
 * a page that only reads an ask carries none of it.
 *
 * A page asks for a reader's code without naming the key: the key is derived in
 * the person's own wallet for that company and the page has no way to know it,
 * so the wallet puts in its own. An ask that names a key for a reader is
 * refused, so no page can have a wallet sign a key that is not its own.
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

/** A reader's public part: the key the company's read grants wrap their keys to, derived in the reader's own wallet. */
export interface ReaderParts {
  readonly kind: 'reader';
  readonly readerKey: string;
}

export type JoinParts = SignerParts | PayeeParts | ReaderParts;

/** What a page may ask a reader's code for: the kind alone, the key left to the wallet. */
export interface ReaderAsked {
  readonly kind: 'reader';
}

/** What a page may ask a wallet to sign: a signer's or payee's parts whole, or a reader's kind alone. */
export type AskedParts = SignerParts | PayeeParts | ReaderAsked;

/** The parts read whole, or null when they are not one of the three kinds exactly. */
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
  if (p.kind === 'reader' && keys === 'kind,readerKey' && typeof p.readerKey === 'string' && HEX64.test(p.readerKey)) {
    return Object.freeze({ kind: 'reader', readerKey: p.readerKey });
  }
  return null;
}

/**
 * The parts a page's ask names, or null: a signer's or payee's read whole, or a
 * reader's kind with nothing beside it. A reader's ask that names a key is
 * refused here, before anything is shown.
 */
export function readAskedParts(value: unknown): AskedParts | null {
  if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).kind === 'reader') {
    return Object.keys(value).length === 1 ? Object.freeze({ kind: 'reader' as const }) : null;
  }
  const read = readJoinParts(value);
  return read === null || read.kind === 'reader' ? null : read;
}

