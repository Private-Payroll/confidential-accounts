/*
 * WHAT A READ OF THE SERVICE IS: read, with what it read, or not readable.
 * Kept apart from the reads themselves, so a file that only asks which one a
 * read is does not carry the code that reads.
 */

/** What a read is: read, or it could not be. */
export const READ = { read: 'read', unreadable: 'unreadable' } as const;
export type Read<T> = { of: typeof READ.read; value: T } | { of: typeof READ.unreadable };

/** Whether `read` was read. */
export const wasRead = <T>(read: Read<T>): read is { of: typeof READ.read; value: T } => read.of === READ.read;

/** Whether the company's records opened. */
export const OPENED = {
  /** Opened with this person's keys. */
  open: 'open',
  /** The keys saved for this person are not open in this tab: their account opens them when they approve. */
  locked: 'locked',
  /** The saved keys are open and hold none for this company: it was created or joined on another device. */
  noKeysHere: 'no-keys-here',
  /** It could not be opened, for a reason a screen says. */
  refused: 'refused',
} as const;
