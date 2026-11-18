/*
 * How this browser's stored records are judged: the error a record that cannot be used raises, and the field checks
 * every record's reader shares.
 */
/**
 * WHAT A STORED RECORD THROWS, NAMED: `session.tsx` used to decide which screen
 * to show by matching one English sentence out of `storage.ts`, so rewording the
 * sentence — a typo fix — would silently disconnect the screen from the state.
 * A named error is a contract code can check and a test can hold; the message
 * stays what a person reads, and rewording it now changes nothing.
 */
export type StorageFailure =
  /** Ciphertext is stored here and the key that opens it is gone. */
  | 'sealed-copy-unopenable'
  /** Something is stored here and it cannot even be read as a record. */
  | 'record-damaged';

export class StorageError extends Error {
  readonly code: StorageFailure;
  constructor(code: StorageFailure, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export const isRealNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isNamed = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '';
