import type { Note, VaultNotes } from './vault-notes.js';

/** The pool after a deposit. */
export const afterDeposit = (state: VaultNotes, note: Note): VaultNotes => {
  if (state.notes.some((n) => n.nonce === note.nonce)) {
    throw new Error(`this vault already holds a note ${note.nonce}`);
  }
  if (note.value <= 0n) throw new Error('a note of nothing is not a deposit');
  /*
   * A deposit cannot know where the chain will file its note: the index is
   * assigned when the transaction is applied, after this is written. A note
   * arriving here with one carries a number that was not read from the chain.
   */
  if (note.index !== undefined) {
    throw new Error(
      `note ${note.nonce} arrives at a deposit already carrying an index. A deposit cannot know `
      + 'where the chain will file it, so that number was not read from the chain and is not '
      + 'recorded. Record the deposit without it; the index is read from the transaction later.');
  }
  return { ...state, notes: [...state.notes, note] };
};
