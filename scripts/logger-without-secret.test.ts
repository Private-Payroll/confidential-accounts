import { describe, expect, it } from 'vitest';
import { loggerWithoutSecret } from './logger-without-secret.js';

describe('a door\'s report never carries the wallet\'s seed', () => {
  /* RED WHEN: a log line naming the seed reaches the report. */
  it('drops a line that carries the seed and passes every other line', () => {
    const lines: string[] = [];
    const logger = { info: (m: string) => { lines.push(m); }, level: 'info' };
    const quiet = loggerWithoutSecret(logger, 'abc123seed');
    quiet.info('Your wallet seed is: abc123seed and your address is: 00');
    quiet.info('Starting wallet...');
    expect(lines).toEqual(['Starting wallet...']);
    expect(quiet.level).toBe('info');
  });

  /* RED WHEN: an empty secret is accepted, which keeps nothing out. */
  it('refuses an empty secret', () => {
    expect(() => loggerWithoutSecret({}, '')).toThrow(/no secret/u);
  });
});
