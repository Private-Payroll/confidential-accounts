/*
 * What a person does on a screen to open an action panel and press it, as steps each counted apart by the count harness: the
 * panel's own root, a press on a button, a press and the words the page says when it went through, the opening of a panel by a
 * press on the screen that draws it, and the steps of one press taken as one.
 */
import { fireEvent } from '@testing-library/react';
import { untilShown } from '../page-shown.test-support.js';
import type { Step } from './company-harness.test-support.js';

/* The panel's own root, which is not the button on the screen that opens it, marked the same. */
export const rootOf = (root: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-action="${root}"]:not(button)`);
export const pressed = (find: () => HTMLElement | null, what: string) => async (): Promise<void> => { fireEvent.click(await untilShown(find, what, 30_000)); };
export const buttonNamed = (name: RegExp): (() => HTMLElement | null) => () => [...document.querySelectorAll<HTMLElement>('button')].find((b) => name.test(b.textContent ?? '')) ?? null;
/* A step that presses `what` and then waits for the words the page says when it went through, handing back the panel's words. */
export const pressesThenSees = (what: () => HTMLElement | null, name: string, done: RegExp, root: string): Step => async () => {
  await pressed(what, name)();
  await untilShown(() => (done.test(document.body.textContent ?? '') ? rootOf(root) : null), `${done}`, 45_000);
  return () => rootOf(root)?.textContent ?? '';
};
/* A step that opens the panel by a press on the screen and waits for its root; the panel's words are what it shows once its reads are quiet. */
export const opensOnTheRoot = (open: () => HTMLElement | null, name: string, root: string): Step => async () => {
  await pressed(open, name)();
  await untilShown(() => rootOf(root), `the ${root} panel`, 30_000);
  return () => rootOf(root)?.textContent ?? '';
};
/* A step for a panel the screen draws with the page: nothing is pressed, and the panel's words are what its root shows once its reads are quiet. */
export const seesTheRoot = (root: string): Step => async () => {
  await untilShown(() => rootOf(root), `the ${root} panel`, 30_000);
  return () => rootOf(root)?.textContent ?? '';
};

/* The steps of one press are one step of the count: what a person presses before the one that runs the action is part of it. */
export const joined = (press: readonly Step[]): Step => async (screen) => {
  let said: Awaited<ReturnType<Step>> = undefined;
  for (const step of press) said = await step(screen);
  return said;
};
