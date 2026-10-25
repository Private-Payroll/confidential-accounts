import { ACT_INTENTS, type IntentShape } from './act-intents.js';

/*
 * One function in a module of its own, so that the two modules that offer it
 * (`request.ts` to the wallet, `act-channel.ts` to the page) hold neither each
 * other nor the channel. It reads the table of actions through its import, so a
 * test that replaces the table replaces what this answers.
 */

/** The entry of an action this wallet runs, by name, or undefined: its fields, its relays, its calls and its outcome. */
export const intentShapeOf = (name: string): IntentShape | undefined => {
  const shapes = ACT_INTENTS as Readonly<Record<string, IntentShape>>;
  return Object.prototype.hasOwnProperty.call(shapes, name) ? shapes[name] : undefined;
};
