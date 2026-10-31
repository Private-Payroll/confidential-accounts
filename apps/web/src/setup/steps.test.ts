import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGES, isBuilt, type Page } from '../pages.js';
import { STEP } from './step-ids.js';
import { EVERY_STEP, isBuiltStep, SETUP_STEPS, type SetupStep } from './steps.js';
import { blockedBy, firstOpen, skippedFor, skipStep, someoneInvited, STANDING, standingOf } from './standing.js';
import type { CompanyCreation } from '../adapters/creation-standing.js';

/*
 * THE ONE LIST OF SETUP STEPS, HELD TO WHAT IT PROMISES: every step is in it,
 * every entry is a step, a step and its page are one component, a step
 * skipped is never taken for done, and the step that must be finished before
 * the others is the one that says so.
 */
const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (p: string): string => readFileSync(SRC + p, 'utf8');
const ACTIONS = 'actions';
const actionFiles = (): string[] => readdirSync(SRC + ACTIONS).filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n)).sort();
/** Every file of the application's own source, relative to it, but tests. */
const everyFile = (dir = ''): string[] => readdirSync(SRC + dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? everyFile(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [`${dir}${e.name}`] : []);
/** Every name a file exports, however it is written. */
const exportedNames = (text: string): string[] => [
  ...[...text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]!),
  ...[...text.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim().split(/\s+as\s+/).pop()!).filter(Boolean)),
  ...(/export\s+default\b/.test(text) ? ['default'] : []),
];
/**
 * Every module a file names, by any way of naming one: an import or export
 * from it, in either quote, and an import() of a string written whole;
 * resolved against the file, without its extension.
 */
const modulesNamed = (file: string, text: string): string[] => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`$]+)\1/g)]
  .map((m) => m[2]!).filter((s) => s.startsWith('.')).map((s) => normalize(join(dirname(file), s)).replace(/\.(js|ts|tsx|jsx)$/, ''));

/** The adapter that acts for each action, which that action alone may import. */
const ACTS_FOR: Record<string, string> = {
  'create-company.tsx': 'adapters/create-company.js',
  'finish-company.tsx': 'adapters/finish-company.js',
  'committee-change.tsx': 'adapters/committee-change.js',
  'create-vault.tsx': 'adapters/create-vault.js',
  'start-again.tsx': 'adapters/start-again.js',
  'account-tokens.tsx': 'adapters/account-balances.js',
  'deposit.tsx': 'adapters/deposit.js',
  'invite.tsx': 'adapters/invite.js',
  'signers.tsx': 'adapters/signer-acts.js',
  /* The People page's two acts share one adapter, because admitting and changing a person are one wallet conversation asked of the same record: the admit control (shown by the person's panel, the invitations page and home) and the panel's change forms. */
  'admit.tsx': 'adapters/person-acts.js',
  'person-panel.tsx': 'adapters/person-acts.js',
  /* The Vendors page's panel acts through the same adapter, because a vendor's record is admitted and changed in the same wallet conversation as a person's. */
  'vendor-panel.tsx': 'adapters/person-acts.js',
};
/** Files other than the action's own that may import its adapter, because they only read what it names: the vault adapter's `namedFor` is the one source of a company's record, label and account (the invite, signer and person acts all ask it), and the invite adapter's role codes, kind names and approvals sentence are read by the signers component, and its amount reader `unitsOf` by the person acts; the Vendors page reads its kind names to open the invite panel for a vendor, and the vendor panel its two kinds of terms; the shared form fields (`fields/form-fields.tsx`) read its keypad, token list and kinds of terms, which they draw and never act on. */
const ALSO_READ_BY: Record<string, string[]> = {
  'adapters/create-vault.js': ['adapters/invite.ts', 'adapters/person-acts.ts', 'adapters/signer-acts.ts'],
  'adapters/person-acts.js': ['records/parts.tsx'],
  'adapters/invite.js': ['actions/signers.tsx', 'actions/vendor-panel.tsx', 'adapters/person-acts.ts', 'fields/form-fields.tsx', 'screens/vendors.tsx'],
};
/** The components in actions/ that are no step's: each with the only files that may show it, one component called from each, never a copy. */
const NO_STEP: Record<string, string[]> = {
  'committee-change.tsx': ['actions/signers', 'records/vault-pending'],
  'start-again.tsx': ['actions/finish-company'],
  'account-tokens.tsx': ['actions/deposit', 'shell/account-menu'],
  'deposit.tsx': ['screens/vault'],
  'admit.tsx': ['actions/person-panel', 'actions/vendor-panel', 'records/parts'],
  'person-panel.tsx': ['screens/people'],
  'vendor-panel.tsx': ['screens/vendors'],
};

describe('every step is in the list, and every entry is a step', () => {
  /*
   * RED WHEN: the list's steps, their order, or which are built changes without
   * this test saying so: a step dropped, a Coming soon step shown as built, or
   * an everyday action (depositing, running payroll) made a setup step again.
   * The design's five steps, written out by hand: there is no step for handing the company over.
   */
  it('has the design\'s five steps, in order, and builds every one of them', () => {
    expect(EVERY_STEP.map((s) => s.id)).toEqual(['createCompany', 'finishCompany', 'signers', 'vault', 'people']);
    expect(EVERY_STEP.filter(isBuiltStep).map((s) => s.id)).toEqual([STEP.createCompany, STEP.finishCompany, STEP.signers, STEP.vault, STEP.people]);
    expect(Object.values(STEP).sort()).toEqual(Object.keys(SETUP_STEPS).sort());
  });

  /* RED WHEN: a file in actions/ is a step's component that no entry shows (a step with no entry), or an entry's component is not in actions/ (an entry with no step). A component no step shows is listed by hand as such. */
  it('shows every component in actions/ that is a step\'s from exactly one entry, and every entry\'s component is one of them', async () => {
    /* One export a file, and that export is, by identity, one entry's component: not a same-named copy made elsewhere. */
    const exported: unknown[] = [];
    for (const f of actionFiles().filter((n) => NO_STEP[n] === undefined)) {
      const names = exportedNames(read(`${ACTIONS}/${f}`));
      expect(names, f).toHaveLength(1);
      const mod = (await import(`../${ACTIONS}/${f.replace(/\.tsx?$/, '.js')}`)) as Record<string, unknown>;
      exported.push(mod[names[0]!]);
    }
    const shown = EVERY_STEP.filter(isBuiltStep).map((s) => (s.shows as { action: unknown }).action);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.every((c) => exported.includes(c))).toBe(true);
    expect(exported.every((c) => shown.includes(c))).toBe(true);
  });

  /*
   * RED WHEN: the committee change is a step again, or is shown from any file but the vault panel's and the signers
   * component's (a copy of it, or a third place it is drawn); or the signers step and the signers page do not draw that one
   * component, the page from its own screen and the step from the list; or the step stops saying that choosing how many
   * must approve is Coming soon.
   */
  it('shows the committee change from the vault panel and the signers component only, which the step and the page both draw', () => {
    /* Every one of them is a file in actions/, and no step shows it. */
    const shown = EVERY_STEP.filter(isBuiltStep).map((st) => (st.shows as { action: { name: string } }).action.name);
    expect(Object.keys(NO_STEP).every((f) => actionFiles().includes(f))).toBe(true);
    expect(shown).not.toContain('CommitteeChange');
    for (const [file, mounts] of Object.entries(NO_STEP)) {
      const target = `${ACTIONS}/${file}`.replace(/\.tsx$/, '');
      expect(everyFile().filter((p) => modulesNamed(p, read(p)).includes(target)).map((p) => p.replace(/\.tsx?$/, '')).sort(), file).toEqual([...mounts].sort());
    }
    const signersStep = SETUP_STEPS[STEP.signers] as SetupStep;
    expect(isBuiltStep(signersStep) && signersStep.shows.action.name).toBe('Signers');
    expect(typeof signersStep.alsoSoon).toBe('function');
    expect(SETUP_STEPS[STEP.signers].page).toBe('settingsSigners');
    expect(PAGES.settingsSigners.shows).toHaveProperty('already');
    expect(((PAGES.settingsSigners as Page).shows as unknown as { already: { screenName: string } }).already.screenName).toBe('SignersBuilt');
    expect(read('screens/settings-sections.tsx')).toMatch(/export function SignersBuilt\b[\s\S]*<Signers \/>/);
    expect(read('screens/settings-sections.tsx')).not.toMatch(/CommitteeChange/);
    expect(read(`${ACTIONS}/signers.tsx`).match(/<CommitteeChange\b/g)).toHaveLength(1);
  });

  /* RED WHEN: a step that can be skipped cannot be, or finishing the company can be skipped. */
  it('lets every step be skipped but finishing the company', () => {
    expect(EVERY_STEP.filter((s) => !s.skippable).map((s) => s.id)).toEqual([STEP.finishCompany]);
  });

  /* RED WHEN: a step other than finishing the company holds the later steps back, or finishing the company no longer does. */
  it('holds the later steps back only until the company is finished', () => {
    expect(EVERY_STEP.filter((s) => s.blocksLater === true).map((s) => s.id)).toEqual([STEP.finishCompany]);
  });
});

describe('a step and its page are one component', () => {
  /*
   * RED WHEN: an action's adapter is imported anywhere but its action's own
   * file, which is what a copy of a step, made into a page or another step,
   * has to do to act; or an action has no adapter listed here; or an adapter two
   * actions share is imported by any file but those two actions (and the files
   * listed as reading what it names), so one of them is not the only way to act.
   */
  it('lets only an action\'s own file reach the adapter that acts for it', () => {
    expect(Object.keys(ACTS_FOR).sort()).toEqual(actionFiles());
    for (const adapter of new Set(Object.values(ACTS_FOR))) {
      const target = adapter.replace(/\.js$/, '');
      const importers = everyFile().filter((p) => modulesNamed(p, read(p)).includes(target));
      const actions = Object.entries(ACTS_FOR).filter(([, a]) => a === adapter).map(([file]) => `${ACTIONS}/${file}`);
      expect([...importers].sort(), adapter).toEqual([...actions, ...(ALSO_READ_BY[adapter] ?? [])].sort());
    }
  });

  /*
   * RED WHEN: a file names a module by a name built at run time (an import()
   * of a template with a value, of a name, or of a sum), which the check above
   * cannot read, so a copy of a step could reach an action's adapter unseen.
   * Every module is named whole, so the check above reads every one.
   */
  it('names every module whole, so the check above reads each', () => {
    const built = /\bimport\s*\(\s*(?!(['"])[^'"`$]*\1\s*\))/g;
    const breaches = everyFile().flatMap((p) => [...read(p).matchAll(built)].map(() => p));
    expect(breaches).toEqual([]);
    /* The check reads what it is for: the list of pages names its screens whole, by import(). */
    expect([...read('pages.ts').matchAll(/\bimport\s*\(\s*'\.\/screens\//g)].length).toBeGreaterThan(5);
    const probe = "const a = import(`../adapters/${n}.js`); const b = import(name); const c = import('../adapters/' + n); const d = import('../x.js');";
    expect([...probe.matchAll(built)].length).toBe(3);
  });

  /*
   * RED WHEN: a built page named by a step shows something other than that
   * step's component from actions/: a screen of its own, or a copy.
   */
  it('shows, on every built page a step names, the step\'s own component', () => {
    const checked: string[] = [];
    for (const s of EVERY_STEP) {
      if (s.page === undefined) continue;
      expect(Object.keys(PAGES), s.id).toContain(s.page);
      const page = PAGES[s.page] as Page;
      if (!isBuilt(page) || !isBuiltStep(s)) continue;
      /* A screen loaded on demand is found by the name the list gives it. */
      const name = (page.shows.screen as { screenName?: string }).screenName ?? page.shows.screen.name;
      const screen = everyFile().find((p) => p.startsWith('screens/') && new RegExp(`export function ${name}\\b`).test(read(p)))!;
      expect(read(screen), s.id).toMatch(new RegExp(`import \\{[^}]*\\b${s.shows.action.name}\\b[^}]*\\} from '\\.\\./${ACTIONS}/`));
      checked.push(`${s.id} on ${s.page}`);
    }
    /* Each built step whose page is built, named here, so the check above is seen reading it. */
    expect(checked).toEqual(['vault on vaults', 'people on people']);
  });
});

describe('each piece the forms and pages share has one home', () => {
  /*
   * RED WHEN: a piece the people's and vendors' pages, panels and the invite form share is written again in another file (a second
   * `useAdmitBySays`, `BeliefLeftOut`, `TermsOf`, `PayField`, `TermsChoice`, `DayForm`, `DateField` or `CalendarDate`), the keypad an
   * amount is typed on is set anywhere but the field that draws it, or a calendar day is written out beside the one that draws it:
   * the copies drift, as the invite form's amount and the vendor panel's did. Each is found by what it is called and by what it does.
   */
  it('defines each shared piece in one file and sets the amount keypad in one', () => {
    const files = everyFile();
    const definedIn = (name: string): string[] => files.filter((p) => new RegExp(`(?:function|const)\\s+${name}\\b`).test(read(p)));
    expect({
      useAdmitBySays: definedIn('useAdmitBySays'), BeliefLeftOut: definedIn('BeliefLeftOut'), TermsOf: definedIn('TermsOf'), CalendarDate: definedIn('CalendarDate'),
      PayField: definedIn('PayField'), TermsChoice: definedIn('TermsChoice'), DayForm: definedIn('DayForm'), DateField: definedIn('DateField'),
    }).toEqual({
      useAdmitBySays: ['actions/admit.tsx'], BeliefLeftOut: ['records/parts.tsx'], TermsOf: ['records/parts.tsx'], CalendarDate: ['records/parts.tsx'],
      PayField: ['fields/form-fields.tsx'], TermsChoice: ['fields/form-fields.tsx'], DayForm: ['fields/form-fields.tsx'], DateField: ['fields/form-fields.tsx'],
    });
    expect(files.filter((p) => /invitations\.kind\./.test(read(p)))).toEqual(['records/parts.tsx']);
    expect(files.filter((p) => /\binputMode\b/.test(read(p)))).toEqual(['fields/form-fields.tsx']);
    expect(files.filter((p) => /\bDECIMAL_KEYPAD\b/.test(read(p)))).toEqual(['adapters/invite.ts', 'fields/form-fields.tsx']);
    expect(files.filter((p) => /calendar\(\w+\) \|\| \w+/.test(read(p)))).toEqual(['records/parts.tsx']);
  });

  /* RED WHEN: the shared form fields file reaches anything but the invite adapter's names, or a form field is imported from an action's file (an action file made a library of fields). */
  it('keeps the shared fields to the names the invite adapter holds, and no action file a library of fields', () => {
    expect(modulesNamed('fields/form-fields.tsx', read('fields/form-fields.tsx')).sort()).toEqual(['adapters/invite']);
    const fieldNames = /\b(?:\w*Form|\w*Field|\w*Choice)\b/;
    for (const f of actionFiles()) {
      const stem = f.replace(/\.tsx?$/, '');
      for (const p of everyFile().filter((x) => x !== `${ACTIONS}/${f}`)) {
        const from = [...read(p).matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'(?:\\./|\\.\\./actions/)${stem}\\.js'`, 'g'))].flatMap((m) => m[1]!.split(',').map((n) => n.trim()).filter(Boolean));
        expect(from.filter((n) => fieldNames.test(n) && n !== 'InvitePeople'), `${p} imports a field from ${f}`).toEqual([]);
      }
    }
  });
});

describe('the vault step', () => {
  /*
   * RED WHEN: a vault of a standing other than one the company's committee
   * holds closes the vault step, which cannot be undone: one not finished,
   * not yet on the chain, held by keys that are not the committee now, or of
   * a standing not known; or one the committee holds does not.
   */
  it('is done only by a vault the company\'s committee holds', async () => {
    const { VAULT } = await import('../adapters/company-records.js');
    const { wasHandedOver } = await import('../adapters/vault-rows.js');
    const held = Object.values(VAULT).filter((standing) => wasHandedOver({ standing }));
    expect(held.sort()).toEqual([VAULT.accountNotFundable, VAULT.accountNotHandedOver, VAULT.held, VAULT.notFundable].sort());
    const vault = EVERY_STEP.find((s) => s.id === STEP.vault)!;
    for (const standing of Object.values(VAULT)) {
      expect(vault.done({ company: 'c-1', vaults: [{ standing }], creation: null, invited: false }), standing).toBe(held.includes(standing));
    }
    expect(vault.done({ company: 'c-1', vaults: null, creation: null, invited: false })).toBe(false);
    expect(vault.done({ company: 'c-1', vaults: [], creation: null, invited: false })).toBe(false);
  });
});

const creation = (over: Partial<CompanyCreation> = {}): CompanyCreation => ({
  company: 'c-1', standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null, ...over,
});

describe('where a step stands', () => {
  const none = { company: null, vaults: null, creation: null, invited: false };
  const created = { company: 'c-1', vaults: null, invited: false, creation: creation({ standing: 'pay-key-owed', confirmedFinished: false, mark: 'not-finished' }) };
  const finished = { ...created, creation: creation() };

  /* RED WHEN: a step skipped is shown as done, a step done is shown as skipped, or a step neither is shown as either. */
  it('never shows a skipped step as done', () => {
    const create = EVERY_STEP.find((s) => s.id === STEP.createCompany)!;
    expect(standingOf(create, none, new Set([STEP.createCompany]))).toBe(STANDING.skipped);
    expect(standingOf(create, none, new Set())).toBe(STANDING.open);
    expect(standingOf(create, created, new Set([STEP.createCompany]))).toBe(STANDING.done);
    for (const s of EVERY_STEP.filter((x) => x.skippable && !x.done(created))) expect(standingOf(s, created, new Set([s.id])), s.id).toBe(STANDING.skipped);
  });

  /* RED WHEN: a step that cannot be skipped is shown as skipped because a skip was kept for it, so the wizard moves past it. */
  it('never shows a step that cannot be skipped as skipped', () => {
    const finish = EVERY_STEP.find((s) => s.id === STEP.finishCompany)!;
    expect(standingOf(finish, created, new Set([STEP.finishCompany]))).toBe(STANDING.open);
  });

  /* RED WHEN: a skip is kept for a step that cannot be skipped, or a step that can be skipped is not kept. */
  it('keeps no skip for a step that cannot be skipped', () => {
    skippedFor('c-skip').clear();
    expect(skipStep('c-skip', STEP.finishCompany)).toBe(false);
    expect([...skippedFor('c-skip')]).toEqual([]);
    expect(skipStep('c-skip', STEP.signers)).toBe(true);
    expect([...skippedFor('c-skip')]).toEqual([STEP.signers]);
    skippedFor('c-skip').clear();
  });

  /* RED WHEN: the company is not done once it exists or its creation is kept in this tab, or is done when neither is so. */
  it('counts creating the company done once it exists, or once this tab keeps its creation', () => {
    const create = EVERY_STEP.find((s) => s.id === STEP.createCompany)!;
    expect(create.done(none)).toBe(false);
    expect(create.done({ ...none, creation: creation({ company: null, standing: null, confirmedFinished: false }) })).toBe(false);
    expect(create.done({ ...none, creation: creation({ company: 'c-new', standing: 'not-created', kept: true, awaitingSecondPress: true, confirmedFinished: false }) })).toBe(true);
    expect(create.done(created)).toBe(true);
  });

  /* RED WHEN: finishing the company is done on the service's word alone, or is not done once the wallet confirms it. */
  it('counts finishing the company done only when the wallet confirms it', () => {
    const finish = EVERY_STEP.find((s) => s.id === STEP.finishCompany)!;
    expect(finish.done(none)).toBe(false);
    expect(finish.done({ ...created, creation: creation({ standing: 'finished', confirmedFinished: false }) })).toBe(false);
    expect(finish.done(created)).toBe(false);
    expect(finish.done(finished)).toBe(true);
  });

  /* RED WHEN: the wizard opens at a step that is done or skipped while one before it is neither. */
  it('opens at the first step neither done nor skipped', () => {
    expect(firstOpen(none, new Set())).toBe(STEP.createCompany);
    expect(firstOpen(created, new Set())).toBe(STEP.finishCompany);
    expect(firstOpen(finished, new Set())).toBe(STEP.signers);
    expect(firstOpen(finished, new Set([STEP.signers]))).toBe(STEP.vault);
  });

  /* RED WHEN: a step after an unfinished company is not held back, one before it or the blocking step itself is, or a finished company holds any back. */
  it('holds back every step after finishing the company until it is done', () => {
    const index = (id: string) => EVERY_STEP.findIndex((s) => s.id === id);
    expect(blockedBy(index(STEP.createCompany), created)).toBeNull();
    expect(blockedBy(index(STEP.finishCompany), created)).toBeNull();
    for (const id of [STEP.signers, STEP.vault, STEP.people]) {
      expect(blockedBy(index(id), created), id).toBe(STEP.finishCompany);
      expect(blockedBy(index(id), none), id).toBe(STEP.finishCompany);
      expect(blockedBy(index(id), finished), id).toBeNull();
    }
  });
});

describe('the People step', () => {
  const read = (value: unknown) => ({ of: 'read', value }) as never;
  const unread = { of: 'unreadable' } as never;
  const vendorsOf = (vendors: unknown[]) => read({ vendors, notBelieved: [], notPayable: [] });
  const person = { id: 'e1', name: 'Ana' };
  const invitation = (kind: string) => ({ kind, name: null, sentAt: '2026-09-11T00:00:00.000Z', expiresAt: null });
  const nobody = { people: read([]), invitations: read([]), vendors: vendorsOf([]) };
  const people = () => EVERY_STEP.find((s) => s.id === STEP.people)!;

  /*
   * RED WHEN: somebody invited to be paid (an invitation waiting for an employee or for a vendor, a person the company holds, a vendor) does
   * not make the step done; or an invitation for a signer does; or a read that failed is counted as somebody, or as nobody
   * when another read says there is somebody.
   */
  it('says somebody is invited once an employee invitation waits, a person is held or a vendor is held, and not for a signer or for nothing read', () => {
    expect(someoneInvited(nobody)).toBe(false);
    expect(someoneInvited({ ...nobody, invitations: read([invitation('employee')]) })).toBe(true);
    expect(someoneInvited({ ...nobody, invitations: read([invitation('signer')]) })).toBe(false);
    expect(someoneInvited({ ...nobody, invitations: read([invitation('vendor')]) })).toBe(true);
    expect(someoneInvited({ ...nobody, people: read([person]) })).toBe(true);
    expect(someoneInvited({ ...nobody, vendors: vendorsOf([{ id: 'v1' }]) })).toBe(true);
    expect(someoneInvited({ people: unread, invitations: unread, vendors: unread })).toBe(false);
    expect(someoneInvited({ people: unread, invitations: read([invitation('employee')]), vendors: unread })).toBe(true);
    expect(someoneInvited({ people: read([person]), invitations: unread, vendors: undefined })).toBe(true);
    expect(someoneInvited({ people: read([]), invitations: read([]), vendors: undefined })).toBe(false);
  });

  /* RED WHEN: the step is done whatever the facts say (it once was never done), or is done without the fact, or the fact is ignored for a skipped step. */
  it('is done exactly when the facts say somebody is invited, and done outranks skipped', () => {
    const facts = { company: 'c-1', vaults: null, creation: null };
    expect(people().done({ ...facts, invited: true })).toBe(true);
    expect(people().done({ ...facts, invited: false })).toBe(false);
    expect(standingOf(people(), { ...facts, invited: true }, new Set([STEP.people]))).toBe(STANDING.done);
    expect(standingOf(people(), { ...facts, invited: false }, new Set([STEP.people]))).toBe(STANDING.skipped);
    expect(standingOf(people(), { ...facts, invited: false }, new Set())).toBe(STANDING.open);
  });

  /* RED WHEN: filing an invitation makes the step undoable-for-good (the wizard would then close its tab), or the signers step takes on a fact the unit did not give it. */
  it('can be returned to once done, and the signers step still has no done fact', () => {
    expect(people().cannotBeUndone).toBe(false);
    const facts = { company: 'c-1', vaults: null, creation: null, invited: true };
    expect(EVERY_STEP.find((s) => s.id === STEP.signers)!.done(facts)).toBe(false);
  });
});
