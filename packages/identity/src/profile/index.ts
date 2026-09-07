/**
 * THE PROFILE AND ITS DISCLOSURE.
 *
 * A person's wallet holds facts about them and can hand a CHOSEN SUBSET of
 * those facts to an application that asks, SIGNED, so the asking application
 * can believe them.
 *
 * **NOTHING IN HERE KNOWS WHAT PAYROLL IS** (§6). Payroll is the first thing
 * that will send a request; the wallet must not be able to tell.
 */
export * from './definition.js';
export * from './attributes.js';
export * from './model.js';
export * from './seal.js';
export * from './store.js';
export * from './payload.js';
export * from './request.js';
export * from './disclosure.js';
export * from './channel.js';
export * from './unlock.js';
export * from './inbox.js';
export * from './inbox-poll.js';
export * from './travel.js';
