/**
 * **WHAT WENT WRONG, WITH EVERYTHING UNDERNEATH IT, IN ONE LINE A PERSON CAN
 * READ.**
 *
 * A failure deep in a library usually arrives wrapped: the contract runtime's
 * own failure becomes "Error executing circuit 'deposit'", with the real reason
 * kept only as its `cause`. A screen that shows only the outer message shows a
 * sentence nobody can act on, and throws away the one that says what broke.
 *
 * So the whole chain is said, outermost first, each step joined by
 * "Underneath that:". A JavaScript error's own kind is kept where it says
 * something (`ReferenceError: Buffer is not defined`), a step that repeats one
 * already said is said once, and a chain that loops or runs very deep stops.
 *
 * It takes anything a `catch` can hold and never throws, because it is called
 * from inside the code that reports failures. It only composes the line: a
 * screen passes it through `shownError`, which redacts it and keeps it in the
 * report.
 */

/** The kinds of JavaScript error whose name says what went wrong, and is kept in front of its message. */
const TELLING_NAMES = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError']);

/** How many steps down a chain of causes is followed before it stops. */
const DEEPEST = 8;

const oneStep = (e: unknown): string => {
  try {
    if (typeof e === 'string') return e.trim();
    if (e === null || e === undefined) return '';
    const name = typeof (e as { name?: unknown }).name === 'string' ? (e as { name: string }).name : '';
    const message = typeof (e as { message?: unknown }).message === 'string'
      ? (e as { message: string }).message.trim()
      : (typeof e === 'object' ? '' : String(e));
    if (message === '') return TELLING_NAMES.has(name) ? name : '';
    return TELLING_NAMES.has(name) && !message.startsWith(name) ? `${name}: ${message}` : message;
  } catch {
    return '';
  }
};

const causeOf = (e: unknown): unknown => {
  try {
    return e !== null && typeof e === 'object' ? (e as { cause?: unknown }).cause : undefined;
  } catch {
    return undefined;
  }
};

/** Every reason in a failure's chain of causes, outermost first, in one line. */
export function whyItFailed(e: unknown): string {
  const said: string[] = [];
  const seen = new Set<unknown>();
  let at: unknown = e;
  for (let depth = 0; depth < DEEPEST && at !== undefined && at !== null && !seen.has(at); depth += 1) {
    seen.add(at);
    const step = oneStep(at).replace(/[.\s]+$/u, '');
    if (step !== '' && !said.includes(step)) said.push(step);
    at = causeOf(at);
  }
  if (said.length === 0) return 'something went wrong, and whatever failed did not say what';
  return said.join('. Underneath that: ');
}
