import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Fault, FAULT } from './faults.js';

/*
 * EVERY MISTAKE THE APPLICATION THROWS CARRIES A CODE A PERSON CAN REPORT.
 * The wording rule keeps English out of the application's code, so an error
 * thrown with a message of its own is refused; one thrown with none says
 * nothing in the console. A code says where.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const files = (dir = ''): string[] => readdirSync(SRC + dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [`${dir}${e.name}`] : []);

describe('a mistake in the code', () => {
  /* RED WHEN: anything is thrown in the application's code but a Fault naming a code from the one table (an empty RangeError, an Error, a string). */
  it('is thrown only as a Fault with a code from the table', () => {
    const throws = files().flatMap((f) => [...readFileSync(SRC + f, 'utf8').matchAll(/\bthrow\b[^;]*;/g)].map((m) => `${f}: ${m[0]}`));
    expect(throws.length).toBeGreaterThan(4);
    expect(throws.filter((t) => !/: throw new Fault\(FAULT\.\w+\);$/.test(t))).toEqual([]);
  });

  /* RED WHEN: two places share a code, a code is not used anywhere, or a Fault's message is not its code. */
  it('names each place once, and says its code', () => {
    const codes = Object.values(FAULT);
    expect(new Set(codes).size).toBe(codes.length);
    const text = files().map((f) => readFileSync(SRC + f, 'utf8')).join('\n');
    for (const k of Object.keys(FAULT)) expect(text.split(`throw new Fault(FAULT.${k});`).length - 1, k).toBe(1);
    const f = new Fault(FAULT.noSession);
    expect([f.message, f.code, f instanceof Error]).toEqual([FAULT.noSession, FAULT.noSession, true]);
  });
});
