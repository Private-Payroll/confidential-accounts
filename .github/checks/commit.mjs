/**
 * WHAT A CHANGE TO THIS REPOSITORY IS CALLED.
 *
 * A commit here is read by people who were not in the room, so the subject line
 * has to say what changed without any of the context that produced it. The same
 * rules apply to a pull request title, because a squashed merge makes the title
 * the subject and the body the body, and to a branch name, which stays on the
 * pull request page after the branch itself is gone.
 *
 * All three are permanent. A file can be corrected by the next commit; a commit
 * message cannot be corrected by anything. So the reading happens before the
 * writing, and it refuses rather than warns.
 *
 * -- WHY THIS FILE HOLDS RULES AND NOTHING ELSE ------------------------------
 *
 * The workflow runs it and no contributor can. A rule that can only be
 * exercised by opening a pull request is a rule nobody has watched refuse, so
 * every judgement here is a pure function of its arguments: no filesystem, no
 * network, no environment. `commit.test.mjs` drives each one directly and
 * watches it refuse, which is the only way this file is checked at all.
 *
 * -- AND WHAT IS DELIBERATELY NOT HERE ---------------------------------------
 *
 * A rule that has to name the thing it forbids publishes that thing in the act
 * of forbidding it. Anything of that kind is held where its data is held, which
 * is not in a repository a stranger clones. What is here is the half that names
 * nothing: shapes, lengths and characters, which a stranger can read, argue
 * with, and satisfy without being told anything private.
 */

/** The kinds of change a subject line may announce, and nothing else. */
export const SUBJECT_KINDS = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'test',
];

/**
 * The kinds a BRANCH may announce. Three fewer than a subject, and the
 * difference is not an oversight: `build`, `ci` and `perf` describe a change to
 * how the software is produced rather than a line of work somebody opens a
 * branch for, and each of those has arrived here as a `chore`.
 */
export const BRANCH_KINDS = ['chore', 'docs', 'feat', 'fix', 'refactor', 'test'];

/** Long enough to say what changed; short enough to read in a log of one-liners. */
export const SUBJECT_LIMIT = 72;

/**
 * A branch name is a path on several filesystems before it is a name on a page,
 * and it is quoted in full in every message about the pull request it carries.
 */
export const BRANCH_LIMIT = 60;

const SUBJECT = new RegExp(`^(${SUBJECT_KINDS.join('|')})(\\(([a-z0-9][a-z0-9._/-]*)\\))?!?: (.+)$`);

const BRANCH = new RegExp(`^(${BRANCH_KINDS.join('|')})\\/[a-z0-9]+(-[a-z0-9]+)*$`);

/** The branches every change here is merged INTO, and never made on. */
const PROTECTED = ['main', 'master', 'HEAD'];

/**
 * THE SHAPES THAT MUST NOT REACH A PUBLIC HISTORY, EACH WITH THE SENTENCE IT
 * EARNS.
 *
 * Shapes rather than words, and that is the whole design. A list of words is
 * data somebody has to maintain and, worse, data this file would contain: a
 * check whose contents are the thing it exists to keep out has published it.
 * A shape carries no examples and goes out of date far more slowly.
 */
const FORBIDDEN = [
  {
    // Every trailer git has ever grown for saying who or what had a hand in a
    // change, matched by its shape. The list of tools that write these would be
    // out of date by the time it was published; the shape has not changed in
    // twenty years.
    // ANCHORED PAST WHATEVER IS IN FRONT OF IT. A trailer arrives indented, or
    // behind the marker a reply quotes with, far more often than it arrives at
    // column zero, and a rule that only matched column zero was letting every
    // one of those through.
    name: 'an attribution trailer',
    pattern: /^[\s>|]*[a-z]+(-[a-z]+)*-by:/im,
    says: 'a change is described by what it does, not by who or what had a hand in it',
  },
  {
    name: 'a line saying what produced the change',
    pattern: /^[\s>|]*(co-)?(generated|authored|created|written)\s+(with|by)\b/im,
    says: 'a change is described by what it does, not by what produced it',
  },
  {
    // The mark a tool leaves on text it wrote part of.
    name: 'a mark left by a tool',
    pattern: /[\u{1F916}\u{1F9BE}]/u,
    says: 'a change is described by what it does, not by what produced it',
  },
  {
    name: 'an address',
    pattern: /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i,
    says: 'a history says what changed; who published it is on the commit already',
  },
  {
    // A path under somebody's home directory names a person and the machine the
    // work was done on, both of which outlive every sweep once they are pushed.
    //
    // MATCHED WHEREVER IT APPEARS AND NOT ONLY AFTER A SPACE. This project
    // writes paths inside backticks as a matter of style, and they arrive
    // inside a URL as often as on their own; a rule that required a delimiter
    // in front read past both. The cost of matching everywhere is that a web
    // address with such a path in it is refused too, and that is the right
    // direction to be wrong in: a false refusal costs one rewording before
    // anything is permanent, and a false acceptance is permanent.
    name: 'a path inside a home directory',
    pattern: /(\/Users\/|\/home\/|~\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/,
    says: 'a history describes the change, not the machine it was made on',
  },
  {
    // Ordinary hyphens throughout. A dash chosen by a text editor reads as one
    // character in the editor and as three bytes everywhere a history is
    // quoted, and there is no way to correct it afterwards.
    // The dash block, and the minus sign beside it, which is not in that block
    // and is what a spreadsheet and several keyboards produce.
    name: 'a dash that is not a hyphen',
    pattern: /[\u2010-\u2015\u2212]/u,
    says: 'a plain hyphen is the only dash a history here carries',
  },
];

/**
 * The first forbidden shape in `text`, or null. `where` names the surface so a
 * refusal reads as an instruction rather than as a complaint.
 *
 * `also` IS THE SEAM, AND IT IS THE WHOLE ANSWER TO A PROBLEM THAT HAS NO OTHER
 * ONE. Some of what must never reach a public history can only be recognised
 * from a list of words, and a file carrying that list has published it in the
 * act of forbidding it. So the list is not here and never will be: it is passed
 * in, by a caller that has it, in a place that is not published. The workflow
 * passes nothing, and every rule above still runs, which is what a stranger's
 * change is held to.
 *
 * Each entry is `{ name, pattern, says }`, exactly like the rules above it.
 */
function unpublishable(text, where, also = []) {
  for (const rule of [...FORBIDDEN, ...also]) {
    const found = rule.pattern.exec(text);
    if (found !== null) {
      return `${where} carries ${rule.name}, ${JSON.stringify(found[0].trim())}. ${rule.says}.`;
    }
  }
  return null;
}

/** What is wrong with a subject line, or null if nothing is. */
export function subjectProblem(subject, also) {
  if (typeof subject !== 'string' || subject.trim() === '') {
    return 'a subject line has to say what the change does, and this one is empty';
  }
  // COUNTED IN CHARACTERS AND NOT IN BYTES. A subject that reads as 72
  // characters on the page is 72 characters whatever alphabet it is written in,
  // and a check that counted bytes would refuse some of them several characters
  // early for a reason nobody can see on the screen.
  const length = [...subject].length;
  if (length > SUBJECT_LIMIT) {
    // SAY WHERE THE CHARACTERS WENT WHEN SOME OF THEM ARE NOT THE AUTHOR'S.
    // A title typed on a page becomes a subject with the change's number on the
    // end, so somebody who counted to exactly the limit is told they are over
    // it by a number they never typed and cannot see. Told that, they shorten
    // the title. Told only that it is too long, they count again and get the
    // same answer.
    const appended = / \(#\d+\)$/.exec(subject);
    const because =
      appended === null
        ? 'the detail belongs in the body'
        : `${[...appended[0]].length} of those are the number appended when this is merged, so the title itself has ${SUBJECT_LIMIT - [...appended[0]].length}`;
    return `a subject line is at most ${SUBJECT_LIMIT} characters and this one is ${length}; ${because}`;
  }
  const parts = SUBJECT.exec(subject);
  if (parts === null) {
    if (/^[a-zA-Z]+(\([^()]*\))?!?: /.test(subject)) {
      const kind = /^[a-zA-Z]+/.exec(subject)?.[0] ?? '';
      if (!SUBJECT_KINDS.includes(kind)) {
        return `"${kind}" is not one of the kinds, which are ${SUBJECT_KINDS.join(', ')}, in lower case`;
      }
      return 'a scope is lower case, digits, and . _ - / only';
    }
    return `a subject line reads "kind: what changed", where kind is one of ${SUBJECT_KINDS.join(', ')}`;
  }
  const description = parts[4] ?? '';
  if (description.endsWith('.')) {
    return 'a subject line does not end with a full stop';
  }
  if (description[0] !== description[0]?.toLowerCase()) {
    return 'a subject line is not capitalised after the colon';
  }
  return unpublishable(subject, 'a subject line', also);
}

/** What is wrong with a branch name, or null if nothing is. */
export function branchProblem(branch, also) {
  if (typeof branch !== 'string' || branch.trim() === '') {
    return 'a branch name has to say what the change does, and none was given';
  }
  // NAMED BEFORE THE SHAPE IS READ, AND THE ORDER IS THE USEFULNESS. Told that
  // `main` is not of the form kind/description, somebody fixes the form. Told
  // that it is the branch every change is merged into, they make a branch. Two
  // different mistakes reported as one is how a check gets a reputation for
  // being unhelpful and then gets worked around.
  if (PROTECTED.includes(branch)) {
    return `"${branch}" is the branch changes are merged INTO, not a branch for a change; open one named after what changed`;
  }
  // READ FOR WHAT MUST NOT BE PUBLISHED BEFORE THE SHAPE IS READ, AND THE ORDER
  // IS THE OPPOSITE OF THE ONE A SUBJECT LINE GETS.
  //
  // The shape below permits lower case, digits and single hyphens and nothing
  // else, so every shape the reading refuses is already outside it. Read second,
  // the reading would be unreachable: a branch name carrying an address would be
  // refused for not being kebab-case, which is true and is not the problem, and
  // the clause meant to catch it would never run at all.
  //
  // A subject line is the other way round because its shape PERMITS all of them:
  // an address, a dash and a trailer all fit a well-formed subject, so there the
  // reading is reachable after the shape and the shape is the more useful thing
  // to say first.
  const carried = unpublishable(branch, 'a branch name', also);
  if (carried !== null) {
    return carried;
  }
  if ([...branch].length > BRANCH_LIMIT) {
    return `a branch name is at most ${BRANCH_LIMIT} characters and this one is ${[...branch].length}`;
  }
  if (!BRANCH.test(branch)) {
    return `a branch name reads "kind/what-changed" in lower case, with single hyphens, where kind is one of ${BRANCH_KINDS.join(', ')}`;
  }
  return null;
}

/**
 * What is wrong with a whole commit message, or null if nothing is.
 *
 * A squashed merge makes a pull request title the subject and its body the
 * body, so the workflow puts the title and the body through THIS function as
 * the message they are about to become. One set of rules rather than two that
 * could drift apart.
 */
export function messageProblem(message, also) {
  if (typeof message !== 'string' || message.trim() === '') {
    return 'a commit message has to say what the change does, and this one is empty';
  }
  const lines = message.replace(/\s+$/, '').split('\n');
  const subject = subjectProblem(lines[0] ?? '', also);
  if (subject !== null) {
    return subject;
  }
  if (lines.length > 1 && (lines[1] ?? '') !== '') {
    return 'a blank line separates the subject from the body';
  }
  return unpublishable(lines.slice(1).join('\n'), 'a commit message', also);
}

/**
 * The subject a squashed merge will actually write, which is not the title
 * typed on the page: the merge appends the pull request number, and a title
 * read without it passes at a length the commit will not have.
 */
export function squashedSubject(title, number) {
  return `${title} (#${number})`;
}
