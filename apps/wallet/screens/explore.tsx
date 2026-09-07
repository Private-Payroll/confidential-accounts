import type { ReactNode } from 'react';
import { ActionTile, ActionTiles, Badge, GLYPH } from '../kit/index.js';
import type { IconSvgElement } from '../kit/index.js';

/**
 * EXPLORE — SIX THINGS, NAMED BEFORE THEY EXIST, AND NOTHING ELSE ON THE PAGE.
 *
 * `#/explore` rendered `screens/notbuilt.tsx`'s honest empty room. This screen
 * replaces that, and the shape of it is the whole argument: **six tiles, each
 * with a quiet badge, and no other words anywhere.**
 *
 * WHY A TILE AND NOT A CARD, A SHEET OR A PARAGRAPH. Everything on this screen
 * is a claim about something that does not exist yet, and the more room a
 * surface gives a claim the more it looks like a description of a thing that
 * has been built. A tile holds a name, one line, and a badge — which is
 * exactly the amount of room the truth needs.
 *
 * **NOTHING HERE IS A NUMBER.** No balance, no count, no activity, nothing
 * fetched, nothing stored, nothing dialled. A screen full of things that do
 * not exist is the easiest place in this wallet to print a plausible figure,
 * and a plausible figure is the one thing on it a person could mistake for
 * real. There is no state in this file, and no import that could acquire any.
 *
 * THE TILES LEAD NOWHERE, AND THE KIT NOW SHOWS THAT. `ActionTile` with
 * neither `href` nor `onClick` has always rendered a plain `div`; this file also
 * takes the hover and the focus ring off that case (`kit/action-tile.tsx`), so
 * six tiles that do nothing no longer light up under a pointer as though they
 * would.
 *
 * `Coming soon`, AND THE DISAGREEMENT THIS FILE ONCE NAMED IS SETTLED.
 *
 * When these six tiles shipped, `screens/home.tsx`'s Earn popup argued the
 * opposite words — *"Coming soon puts a date in the reader's head that nobody
 * has committed to"* — and said `Not built yet` instead. Both phrases were on
 * screen at once in different rooms, and this file named the disagreement
 * rather than absorbing it: *one of the two should win.*
 *
 * **IT WON. `Coming soon` IS THE PHRASE, EVERYWHERE A PLANNED FEATURE IS
 * NAMED.** Earn's tile, Earn's popup, that popup's comment, the four badges in
 * Home and Settings and the sweep's paragraph in `shell/switcher.tsx` were all
 * moved to match these six; these six did not move. **This is recorded rather
 * than left as a note, so the next round finds a decision instead of an open
 * question.** Two rooms of one wallet using two phrases for one state is worse
 * than either phrase, and the case against this one was never that it was
 * false — only that it was warmer than the alternative.
 *
 * WHAT THE LOSING ARGUMENT WAS RIGHT ABOUT IS KEPT, AND IT IS THE HALF THAT
 * WAS EVER LOAD-BEARING: no surface may name a month, a quarter, a season or a
 * version, and Earn's panel still says outright that there is no date and will
 * not invent one. `home.test.tsx` asserts exactly that of the panel. *Soon* is
 * a temperature; `Q3` is a promise, and only a promise can stop a sentence
 * being true in a year.
 *
 * NOT `screens/notbuilt.tsx`. That screen is about a ROUTE WITH NO SCREEN
 * BEHIND IT — a different statement, in different words, and untouched.
 */

interface Coming {
  readonly glyph: IconSvgElement;
  readonly name: string;
  /** One line, and it must survive a year of being read. */
  readonly says: string;
}

/**
 * THE SIX, IN THE ORDER THE DESIGN NAMES THEM.
 *
 * THE GLYPHS ARE ALL EXISTING NAMES OUT OF `kit/icon.tsx`, and none of them is
 * one the navigation is wearing at the same moment. That is the constraint
 * `icon.tsx` states for `details`/`contacts` — *two things side by side under
 * one drawing is two things a person has to read rather than recognise* — and
 * on this screen the rail is beside the tiles, so `home`, `activity`,
 * `explore` and `settings` are all spoken for and none of them appears below.
 *
 * ONE LINE WAS REWRITTEN AND IT IS THIS ONE: **Earn**. The design offered
 * *"without publishing what you hold"*, which claims a PRIVACY property of a
 * mechanism nobody has built here — a stake is ordinarily visible to whatever
 * pays the reward, and this project has never claimed otherwise. Home's Earn
 * popup already states the claim this wallet does make: *"putting NIGHT to
 * work without handing it to anybody"*, which is about CUSTODY and is true of
 * the design as it stands. Two surfaces naming one feature must not disagree,
 * so this tile carries Home's sentence rather than a second one.
 */
const SIX: readonly Coming[] = [
  {
    /* The document you would otherwise have handed over. */
    glyph: GLYPH.details,
    name: 'ZK KYC',
    says: 'Prove you passed a check without handing over the documents you passed it with.',
  },
  {
    /* Checked, and still covered. */
    glyph: GLYPH.secured,
    name: 'Proof of Personhood',
    says: 'Prove there is one person behind this wallet, without proving which person.',
  },
  {
    /* Money arriving, which is the whole of what winning is. */
    glyph: GLYPH.receive,
    name: 'Private Lottery',
    says: 'Buy a ticket and be paid if you win, without a list of who played.',
  },
  {
    /* Something delivered to an organisation. */
    glyph: GLYPH.inbox,
    name: 'Whistleblow',
    says: 'Say something to an organisation that cannot work out who said it.',
  },
  {
    glyph: GLYPH.earn,
    name: 'Earn',
    says: 'Put NIGHT to work without handing it to anybody.',
  },
  {
    /* The mark a ballot carries. */
    glyph: GLYPH.chosen,
    name: 'Vote',
    says: 'Cast a vote that counts once and names nobody.',
  },
];

export function Explore(): ReactNode {
  return (
    <div className="flex flex-col gap-8">
      {/* THE HEADING STAYS, AND IT IS NOT AN EXCEPTION TO *nothing else*.
        * `app.tsx` moves focus to `main` on every navigation so a screen
        * reader announces the room from its heading, and `screens/notbuilt.tsx`
        * printed `Explore` here before this screen existed. Removing it would
        * take the room's name away from the one person who cannot see the rail
        * highlighting it. It is the place's name and no sentence follows it. */}
      <h1 className="m-0">Explore</h1>

      {/* THREE ACROSS ABOVE THE LAYOUT SWITCH, NOT FOUR. `ActionTiles` is
        * built for Home's set of four (`kit/action-tile.tsx`); six tiles in a
        * four-wide grid is a row of four and an orphaned pair. The override
        * goes through `cn`, which is `tailwind-merge` and REPLACES rather than
        * appends — measured. Two across on a phone is
        * the kit's own default and is untouched. */}
      <ActionTiles className="wide:grid-cols-3">
        {SIX.map((one) => (
          <ActionTile
            key={one.name}
            glyph={one.glyph}
            label={one.name}
            says={one.says}
            /* The line is the point of the tile and there is no screen behind
             * this one to read it on — so it wraps instead of being cut. */
            saysWraps
            trailing={<Badge>Coming soon</Badge>}
          />
        ))}
      </ActionTiles>
    </div>
  );
}
