/**
 * **HOW THE COMPANY'S VIEW ASKS FOR MANY THINGS AT ONCE.** Every ask a view makes in one turn of the page's work is
 * joined into one request for each kind of thing asked, past `READ_AT_ONCE` in one request for each part of that many,
 * and every answer is kept for the rest of the view: asking the same thing again, in the same turn or later, sends
 * nothing.
 */
import { READ_AT_ONCE } from './records-source.js';

/**
 * Asks `ask` for `items` in parts of at most `size`, all parts at once, and gives back every answer in the order of
 * `items`. An answer that does not hold one entry for each item of its part is refused.
 */
export async function inParts<T, R>(
  items: readonly T[],
  ask: (part: readonly T[]) => Promise<readonly R[]>,
  size = READ_AT_ONCE
): Promise<R[]> {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  const answers = await Promise.all(
    parts.map(async (part) => {
      const answer = await ask(part);
      if (answer.length !== part.length)
        throw new Error(`an answer held ${answer.length} entries for the ${part.length} asked`);
      return answer;
    })
  );
  return answers.flat();
}

/**
 * Asks made in one turn, joined and kept. `get(item)` answers from what is kept when it was asked before; otherwise
 * it waits for the end of the turn, when every new item asked in it goes out in one `inParts` ask. A failed ask is
 * not kept: each of its items is refused to everyone who asked it in that turn, and the next ask of any of them goes
 * out again. Whether a failure ends the view is the owner's decision, not this class's.
 */
export class JoinedAsks<T, R> {
  private readonly kept = new Map<string, Promise<R>>();
  private waiting: { readonly key: string; readonly item: T; readonly settle: (r: Promise<R>) => void }[] = [];

  constructor(
    private readonly keyOf: (item: T) => string,
    private readonly ask: (part: readonly T[]) => Promise<readonly R[]>
  ) {}

  get(item: T): Promise<R> {
    const key = this.keyOf(item);
    const there = this.kept.get(key);
    if (there !== undefined) return there;
    const answer = new Promise<R>((resolve) => {
      if (this.waiting.length === 0) queueMicrotask(() => this.flush());
      this.waiting.push({ key, item, settle: resolve });
    });
    this.kept.set(key, answer);
    return answer;
  }

  /** Asks for many at once; their answers, in the order asked. */
  many(items: readonly T[]): Promise<R[]> {
    return Promise.all(items.map((i) => this.get(i)));
  }

  /** Forgets the answers of the items named, so the next ask of each goes out again. */
  drop(match: (key: string) => boolean): void {
    for (const key of [...this.kept.keys()]) if (match(key)) this.kept.delete(key);
  }

  private flush(): void {
    const now = this.waiting;
    this.waiting = [];
    const all = inParts(
      now.map((w) => w.item),
      this.ask
    );
    now.forEach((w, i) => w.settle(all.then((answers) => answers[i]!)));
    all.catch(() => {
      for (const w of now) if (this.kept.get(w.key) !== undefined) this.kept.delete(w.key);
    });
  }
}
