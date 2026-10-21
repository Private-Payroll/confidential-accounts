/**
 * **ONE SEND AT A TIME FOR THE COMPANY BEING CREATED**, shared by the step that carries it (`finish-company.ts`) and the
 * one that starts it again (`start-again.ts`): which carry and which wallet press are in flight, and whether a creation
 * is being started again. Starting again waits for the first two to end and holds them off until it is settled, since a
 * step built and sent beside it would put back a creation just set aside and pay for a deploy nobody wants.
 */
export const lane: {
  carrying: Promise<unknown> | null;
  pressing: Promise<unknown> | null;
  holding: Promise<void> | null;
  sending?: boolean;
} = { carrying: null, pressing: null, holding: null };

/** Runs `work` once no carry and no press is in flight, and holds every carry and press off until it ends. */
export async function whileNothingIsSent<T>(work: () => Promise<T>): Promise<T> {
  while (lane.carrying !== null || lane.pressing !== null || lane.holding !== null) {
    await Promise.allSettled([lane.carrying, lane.pressing, lane.holding]);
  }
  const mine = work();
  const mark = mine.then(() => undefined, () => undefined);
  lane.holding = mark;
  try {
    return await mine;
  } finally {
    if (lane.holding === mark) lane.holding = null;
  }
}
