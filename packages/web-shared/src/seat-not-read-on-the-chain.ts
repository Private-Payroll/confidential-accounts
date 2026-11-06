/**
 * What a device makes of its read of which seat each invitation's proposal took, the one meaning every reader of it
 * shares (`seatsTakenAsked`). A read not made says nothing about the seat itself: the chain's read failed or ran out of
 * time, or the company's proposals could not be read from the service, and reading again reads them again; or the
 * person's wallet names no indexer, and only naming one resolves it. A seating the read refuses for good is neither: the
 * chain shows two seats under one proposal, or a seating this device cannot read as one invitation and one seat, and
 * reading again does not change it.
 */

/** The seat each proposal asked about took on the chain, by its identity, null where none: the door every reader asks through. */
export type InvitedSeatsRead = (proposals: readonly string[]) => Promise<Readonly<Record<string, string | null>>>;

/** The names each stop is noted under; a name crosses the vault worker with its words, where a class does not. */
export const SEAT_READ_STOP = {
  notRead: 'SeatNotReadOnTheChain', noIndexer: 'NoIndexerToReadTheChain', refused: 'SeatingRefusedOnTheChain', proposalsNotRead: 'proposals-not-read',
} as const;

/** What stopped a waiting seat from being read when the company's proposals could not be read from the service. */
export const PROPOSALS_NOT_READ = SEAT_READ_STOP.proposalsNotRead;

/**
 * Thrown when a read of the chain, or of the company's proposals, could not be made. It says nothing about the seat
 * itself, so nobody is refused for good: pressing again reads again. Without words of its own it speaks of the seat an
 * invitation's proposal took.
 */
export class SeatNotReadOnTheChain extends Error {
  constructor(said?: string) {
    super(said ?? ('This device could not read from the network which seat this invitation\'s proposal took, so nobody was admitted yet. '
      + 'Nothing was sent. Press again to read the network again.'));
    this.name = SEAT_READ_STOP.notRead;
  }
}

/** Thrown when the person's wallet names no indexer to read the chain through: pressing again cannot resolve it. */
export class NoIndexerToReadTheChain extends Error {
  constructor() {
    super('your wallet did not name the indexer it reads the network through, so which seat an invitation\'s proposal took was not '
      + 'read. Nothing was changed. Open your wallet, check its network, and reload the page');
    this.name = SEAT_READ_STOP.noIndexer;
  }
}

/**
 * Thrown when the chain was read and shows a seating this device must not tell as any seat: reading again shows the same,
 * so its words name what the company does about it.
 */
export class SeatingRefusedOnTheChain extends Error {
  constructor(said: string) {
    super(said);
    this.name = SEAT_READ_STOP.refused;
  }
}

/** Two seatings closed one proposal. */
export const TWO_SEATINGS = 'two seats were taken on the account under one invitation\'s proposal, so which is the invited person\'s was not '
  + 'decided, and reading again will not change it. The company removes the seat it did not mean, then reads again';

/** A seating transaction that does not read as one closed proposal and one seat. */
export const UNREAD_SEATING = 'a seat taken on the account was read from a transaction that does not show one invitation and one seat, so '
  + 'which invitation it answered was not decided, and reading again will not change it. The company removes that seat and invites '
  + 'the person again';

/**
 * Whether anything that stopped the read of the seats people wait for was a read this device could not make, told by
 * the name each stop was noted under (`SEAT_READ_STOP`: the class name is the stop word a roster notes for it). A request refused on what it carries, or a seating refused for good, is no such stop.
 */
export const aReadNotMade = (stopped: readonly string[]): boolean =>
  stopped.some((x) => x === SEAT_READ_STOP.notRead || x === SEAT_READ_STOP.noIndexer || x === PROPOSALS_NOT_READ);

/**
 * **THE SEAT EACH PROPOSAL TOOK, ASKED THROUGH `door`, OR WHY NOT**: the answer only when it holds every proposal asked
 * about. A missing door, a failed read and an answer without a proposal asked about are a read not made
 * (`SeatNotReadOnTheChain`, with `said` as its words when given); a wallet that names no indexer and a seating refused for
 * good are passed on as they were thrown, told by their name, which the vault worker keeps.
 */
export const seatsTakenAsked = async (
  door: InvitedSeatsRead | undefined, proposals: readonly string[], said?: string,
): Promise<Readonly<Record<string, string | null>>> => {
  if (door === undefined) throw new SeatNotReadOnTheChain(said);
  let answered: Readonly<Record<string, string | null>>;
  try {
    answered = await door(proposals);
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === SEAT_READ_STOP.noIndexer || name === SEAT_READ_STOP.refused) throw e;
    throw new SeatNotReadOnTheChain(said);
  }
  /* A read of the chain answers every proposal asked about, null where it shows no seat taken; one that answers less did not read it. */
  if (typeof answered !== 'object' || answered === null || proposals.some((p) => !Object.hasOwn(answered, p))) throw new SeatNotReadOnTheChain(said);
  return answered;
};
