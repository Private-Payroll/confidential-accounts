/*
 * The wallet library's provider writes the wallet's seed into its log when it
 * builds a wallet, and a door's log is its report, which is read and passed
 * around. This hands the library a logger that drops any line carrying the
 * secret it is given, and passes every other line through unchanged.
 */

/** `logger`, with every call whose arguments carry `secret` as text dropped; refuses an empty secret, which would drop nothing. */
export function loggerWithoutSecret<L extends object>(logger: L, secret: string): L {
  if (secret.trim() === '') throw new Error('no secret was given to keep out of the log, so nothing would be kept out');
  const carries = (a: unknown): boolean => typeof a === 'string' && a.includes(secret);
  return new Proxy(logger, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => (args.some(carries) ? undefined : value.apply(target, args));
    }
  });
}
