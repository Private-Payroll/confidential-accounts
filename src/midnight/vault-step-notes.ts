/**
 * **THE NOTES A VAULT STEP IS HANDED, PLACE BY PLACE.**
 *
 * A payment draws on the note its `noteToSpend` witness offers and one further
 * place; a batch on three places; a merge on four. Each is a fixed-length
 * argument, so a step that needs fewer notes fills the rest with an unused
 * place: a note worth nothing, which the vault spends nothing for. No note the
 * vault holds is worth nothing, so an unused place can never stand for one.
 */

/** A coin as the vault's circuits take a held note: its nonce, token, value and place in the chain's tree. */
export interface NotePlace {
  readonly nonce: Uint8Array;
  readonly color: Uint8Array;
  readonly value: bigint;
  readonly mt_index: bigint;
}

/** A place that spends nothing. */
export const unusedNotePlace = (): NotePlace => ({
  nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n, mt_index: 0n,
});

/**
 * Exactly `size` places: the notes given, in order, then unused places. Refuses
 * more notes than places, and a note worth nothing, which the vault would read
 * as unused and so not spend.
 */
export const notePlaces = (notes: readonly NotePlace[], size: number): NotePlace[] => {
  if (notes.length > size) {
    throw new Error(`a step takes at most ${size} note(s) here and was given ${notes.length}; plan the run again so each step fits.`);
  }
  for (const n of notes) {
    if (n.value <= 0n) throw new Error('a note worth nothing was handed in. The vault reads it as an unused place and would not spend it, so hand a step only notes that hold something.');
  }
  return [...notes, ...Array.from({ length: size - notes.length }, unusedNotePlace)];
};

/** The one further place a single payment takes, when it spends only the note it is offered. */
export const noFurtherNote = (): NotePlace[] => notePlaces([], 1);
