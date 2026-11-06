/**
 * The one plain line a wallet window ends with when a call it finished went another way than the company's service:
 * straight to the chain, or with the fee paid from the person's own DUST, and why. Each mix of reasons has one line.
 */
/** Which fallbacks one window used, as the one plain line its end shows. */
export const FELL_BACK: Readonly<Record<string, string>> = Object.freeze({
  chain: 'act.fell-back.chain', 'own-dust': 'act.fell-back.own-dust', 'chain,own-dust': 'act.fell-back.chain-own-dust',
  unread: 'act.fell-back.unread', 'unread,own-dust': 'act.fell-back.unread-own-dust',
  unreached: 'act.fell-back.unreached', 'unreached,own-dust': 'act.fell-back.unreached-own-dust',
  'chain,unreached': 'act.fell-back.chain-unreached', 'chain,unreached,own-dust': 'act.fell-back.chain-unreached-own-dust',
});
/* The order the reasons are named in, so each mix of them is one key of `FELL_BACK`. */
export const FELL_ORDER = ['chain', 'unread', 'unreached', 'own-dust'] as const;
/** One reason a window's call went another way than the company's service. */
export type FellBack = (typeof FELL_ORDER)[number];

/**
 * The one plain line for the reasons a window fell back for. An unread choice sends every call straight from the
 * start, so it never mixes with our service being unable to take a call or unreachable; every other mix has a line.
 */
export const fellBackLine = (fell: ReadonlySet<FellBack>): string | undefined =>
  FELL_BACK[FELL_ORDER.filter((x) => fell.has(x)).join(',')];
