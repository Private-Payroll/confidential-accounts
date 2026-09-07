import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * ────────────────────────────────────────────────────────────────────────────
 * THE RESTING AFFORDANCE.
 *
 * **WHAT THIS CANNOT DO, SAID BEFORE WHAT IT DOES.** It cannot assert that the
 * control is VISIBLE. jsdom computes no cascade worth trusting, applies no
 * `@media` block, resolves no `var()`, and this stylesheet's colours are two
 * `var()` hops deep behind Tailwind v4's `@theme` — so `getComputedStyle` on a
 * rendered button returns nothing that means anything here. A test written that
 * way would pass whatever `app.css` said, which is worse than no test.
 *
 * SO IT READS THE STYLESHEET AS TEXT, which is the method `theme-palette.test
 * .ts` established for this file and for this reason. What it pins is the one
 * thing that actually failed: the RESTING rule carried no affordance and the
 * `:hover` rule carried all of it. That is a fact about the source and it is
 * checkable from the source.
 *
 * WHAT IS STILL NOT PINNED, AND IS NOT PRETENDED TO BE: that the resting border
 * has enough contrast against the card behind it to be SEEN, in each of the
 * theme blocks. That is a measurement against rendered pixels; this repository
 * has no such harness and this change did not build one. It is `UNSURE` in the
 * log rather than a green assertion here.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe('§1 — a quiet button carries its affordance with no pointer on it', () => {
  /** The stylesheet with comments stripped. `theme-palette.test.ts` found the
   * hard way that a test matching inside a comment is a test that passes after
   * the rule has been deleted — and the comments above `button.quiet` quote the
   * old declarations verbatim, so this is load-bearing here in particular. */
  const CSS = readFileSync(
    fileURLToPath(new URL('./app.css', import.meta.url)),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  /** The declarations of the rule whose selector is EXACTLY `selector`. The
   * bodies here contain no nested braces, so the scan is a scan and not a
   * parser. Anchored on `}` or start-of-file so `button.quiet` cannot match
   * inside `button.quiet.inline`. */
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.:]/g, (c) => `\\${c}`);
    const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
    /* `noUncheckedIndexedAccess` is on, so the capture is `string | undefined`
     * whatever the regex looks like. Asserted rather than cast. */
    const body = found?.[1];
    expect(body, `no rule for ${selector}`).toBeDefined();
    return body ?? '';
  };

  it('THE DEFECT, PINNED: the resting rule sets a border-color, and it is not transparent',
    () => {
      const resting = rule('button.quiet');
      /* What was there before was `border-color: transparent;` — this
       * assertion is the one that goes red if it comes back. */
      expect(resting).toMatch(/border-color:\s*var\(--border-strong\)/);
      expect(resting).not.toMatch(/border-color:\s*transparent/);
    });

  it('and the hover rule is a CHANGE to that affordance, never the whole of it', () => {
    const resting = rule('button.quiet');
    const hover = rule('button.quiet:hover');
    /* Both set it. The failure mode being pinned is precisely "only hover
     * does", so the test that matters is that the resting rule sets it — the
     * hover rule is read here only to prove the two are different values and
     * hover therefore still has something to say. */
    expect(hover).toMatch(/border-color:/);
    expect(resting).not.toBe(hover);
  });

  /**
   * THE ONE VARIANT DELIBERATELY NOT GIVEN A BORDER. `button.quiet.inline` sits
   * between words in running prose in two places, where a bordered chip breaks
   * the line rather than announcing a control. It carries an affordance all the
   * same, and the assertion is that it carries one — not that it carries a box.
   */
  it('the inline variant declines the border and takes an underline instead', () => {
    const inline = rule('button.quiet.inline');
    expect(inline).toMatch(/border-color:\s*transparent/);
    expect(inline).toMatch(/text-decoration:\s*underline/);
    expect(inline).toMatch(/color:\s*var\(--accent\)/);
  });
});
