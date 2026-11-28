/*
 * The action panels the count files open, and how each is counted: the panels the harness draws ready on their own, the
 * panels the page hands the company's read, opened inside the screen that draws them and pressed, and the branches of a
 * page the stand-ins' usual answers do not reach, each made for the company it is opened on, so one file counts them at
 * the company's people, vendors, vaults and proposals and another as its money grows.
 */
import { createElement, type ReactElement } from 'react';
import { fireEvent } from '@testing-library/react';
import { withPin } from 'vaults-web-shared/keyring-blob.js';
import {
  openPanel,
  openScreen,
  openScreenAnd,
  servedAs,
  type CompanyHeld,
  type CompanyOpened,
  type Served,
  type ScreenCount,
  type Step
} from './company-harness.test-support.js';
import {
  buttonNamed,
  joined,
  opensOnTheRoot,
  pressesThenSees,
  rootOf,
  seesTheRoot
} from './panel-steps.test-support.js';
import { Deposit } from '../actions/deposit.js';
import { InvitePeople } from '../actions/invite.js';
import { OneOffPayment } from '../actions/one-off.js';
import { RetireVault } from '../actions/retire-vault.js';
import { Signers } from '../actions/signers.js';
import { untilShown } from '../page-shown.test-support.js';
import { readsOf, type PageId, type Reads } from './screen-counts.test-support.js';
import {
  askedBeyondWhatGrew,
  askedKindsChanged,
  carriedNotAsHeldIn,
  type Called
} from './screen-carried.test-support.js';

/** The person a panel is drawn for: the company's founding seat. */
export const founderOf = (company: CompanyOpened): string => company.seats()[0]!.person;

/* What the screen that shows a step hands it: where to lead the person, and what to do when it changed something, here nothing. */
const STEP_PROPS = { leadTo: () => {}, onChanged: () => {} };

/* Each panel the harness draws ready on its own, by its name on the inventory, with the properties it is given. */
export const panelsOn = (company: CompanyOpened): Readonly<Record<string, () => ReactElement>> => ({
  deposit: () => createElement(Deposit, { company: company.fields.record, vault: company.vaults()[0]!, ...STEP_PROPS }),
  invite: () => createElement(InvitePeople, {}),
  'one-off': () => createElement(OneOffPayment, { vault: company.vaults()[0]! }),
  'retire-vault': () => createElement(RetireVault, { vault: company.vaults()[0]! }),
  signers: () => createElement(Signers, {})
});

/* The words each of those panels draws and the frame it is drawn in does not. */
export const DRAWS: Readonly<Record<string, string>> = Object.freeze({
  deposit: 'Ways to put money in',
  invite: 'Invite',
  'one-off': 'Propose payment',
  'retire-vault': "Retiring takes this vault off your company's list.",
  signers: 'Add from code'
});

/* The words a panel draws when it could not read what it needs, which a panel drawn ready does not. */
export const NOT_READ =
  /could not be (read|loaded|checked)|did not finish|not finished being created|not set up|Checking who holds|could not check who holds|has no vault to pay from yet/u;

/** The screen that draws a panel, by its file and the panel's name in it, so a claim of where a panel is drawn is read from the screen. */
export interface DrawnBy {
  readonly screen: string;
  readonly component: string;
}

/** What a person does on a screen to open a panel there, and what they do on the panel to press it, as steps each counted apart. */
export interface InItsScreen {
  /** The screen the panel is drawn by, and the page it is opened on. */
  readonly by: DrawnBy;
  readonly page: string;
  readonly params: () => Record<string, string>;
  /** The step that opens the panel, or null for a panel the page draws with the page: its reads are then the page's own opening. */
  readonly opens: Step | null;
  /** What the stand-ins are turned to answer for the panel to have something to do. */
  readonly served?: Partial<Served>;
  /** What the panel's own root is marked with. */
  readonly root: string;
  readonly draws: string;
  /** The steps of one press on the panel, ending when the panel says it was done. */
  readonly press: readonly Step[];
}

/* The panels the page hands the company's read, each opened inside its own screen: what the screen draws and what a person does there. */
export const inItsScreenOn = (company: CompanyOpened): Readonly<Record<string, InItsScreen>> => ({
  'change-threshold': {
    by: { screen: 'vault.tsx', component: 'ChangeThreshold' },
    page: 'vault',
    params: () => ({ vault: company.vaults()[0]! }),
    root: 'change-threshold',
    opens: opensOnTheRoot(buttonNamed(/^Change approvals$/u), 'Change approvals', 'change-threshold'),
    draws: 'Approvals this vault asks for',
    press: [
      async () => {
        fireEvent.click(
          await untilShown(
            () => document.querySelector<HTMLElement>('[data-action="threshold-fewer"]'),
            'fewer approvals',
            30_000
          )
        );
      },
      pressesThenSees(
        () => document.querySelector<HTMLElement>('[data-action="raise-threshold"]'),
        'Ask for this number',
        /Raised\./u,
        'change-threshold'
      )
    ]
  },
  'committee-change': {
    by: { screen: 'super-admins.tsx', component: 'CommitteeChange' },
    page: 'settingsSuperAdmins',
    params: () => ({}),
    root: 'committee-change',
    opens: null,
    served: { committee: 'change-owed' },
    draws: 'Signatures so far',
    press: [
      async () => {
        fireEvent.click(
          await untilShown(
            () => document.querySelector<HTMLElement>('[data-action="sign-change"]'),
            'sign the change',
            30_000
          )
        );
      },
      async () => {
        fireEvent.click(await untilShown(buttonNamed(/^Confirm$/u), 'Confirm', 30_000));
        await untilShown(() => document.querySelector('[data-acted="sign-change"]'), 'the change signed', 30_000);
        return () => rootOf('committee-change')?.textContent ?? '';
      }
    ]
  },
  'create-vault': {
    by: { screen: 'vaults.tsx', component: 'CreateVault' },
    page: 'vaults',
    params: () => ({}),
    root: 'create-vault',
    opens: opensOnTheRoot(buttonNamed(/^Create a vault$/u), 'Create a vault', 'create-vault'),
    draws: 'Enter a name to create the vault.',
    press: [
      async () => {
        /* The founding seat's wallet holds the company as the one it created, as the wallet that created the company does. */
        const founder = company.wallet(founderOf(company));
        founder.kept = withPin(
          founder.kept,
          company.fields.company,
          company.fields.account,
          'created',
          '2026-01-01T00:00:00.000Z'
        );
        fireEvent.change(
          await untilShown(
            () => document.querySelector<HTMLElement>('[data-field="vault-name"]'),
            'the vault name',
            30_000
          ),
          { target: { value: 'Operations' } }
        );
      },
      async () => {
        fireEvent.click(
          await untilShown(
            () => document.querySelector<HTMLElement>('[data-action="create-vault-now"]:not([disabled])'),
            'create the vault',
            30_000
          )
        );
      },
      async () => {
        fireEvent.click(await untilShown(buttonNamed(/^Confirm$/u), 'Confirm', 30_000));
        await untilShown(
          () => document.querySelector('[data-outcome] [data-result], [data-outcome] [data-created]'),
          'the vault created',
          120_000
        );
        return () => rootOf('create-vault')?.textContent ?? '';
      }
    ]
  }
});

/*
 * The branches a page takes that the usual answers of the stand-ins do not reach: a vault that holds public money beside one that
 * holds none, a pay key not committed on the account, and a change of the company's committee owed. Each is a page opened twice on a
 * device that has checked the company before (the second opening counted), as the usual one is, under the answers the branch
 * needs; `differs` is each read the branch moves from the page's pinned reads (0 is a read the branch does not make). The count
 * is then held the same at the company grown. `shows` is the words that only the branch's page draws.
 */
export interface Branch {
  readonly page: PageId;
  readonly served: Partial<Served>;
  readonly params?: () => Record<string, string>;
  readonly shows: RegExp;
  readonly differs: Reads;
}
export const COMMITTEE_CHANGE_READ = 'route GET /api/accounts/:id/committee-change (no action declares it)';
export const branchesOn = (company: CompanyOpened): Readonly<Record<string, Branch>> => ({
  'the vaults page, with a vault holding public money beside one holding none': {
    page: 'vaults',
    served: { publicMoney: 'second' },
    shows: /This vault holds none of the tokens this app shows\..*This vault holds 1 token this app does not know/u,
    differs: {}
  },
  'the home page, with a vault holding public money beside one holding none': {
    page: 'home',
    served: { publicMoney: 'second' },
    shows: /This vault holds none of the tokens this app shows\..*This vault holds 1 token this app does not know/u,
    differs: {}
  },
  'the page of a vault holding public money': {
    page: 'vault',
    served: { publicMoney: 'second' },
    params: () => ({ vault: company.vaults()[1]! }),
    shows: /This vault holds 1 token this app does not know/u,
    differs: {}
  },
  'the vaults page, with no vault holding public money': {
    page: 'vaults',
    served: {},
    shows: /holds none of the tokens this app shows\..*holds none of the tokens this app shows\./u,
    differs: {}
  },
  'the home page, with the pay key not committed': {
    page: 'home',
    served: { payKey: 'not-committed' },
    shows: /3 of 5 steps done/u,
    differs: {}
  },
  'the super admins page, with a change of the committee owed': {
    page: 'settingsSuperAdmins',
    served: { committee: 'change-owed' },
    shows: /0 of 2 signed/u,
    differs: { [COMMITTEE_CHANGE_READ]: 1 }
  }
});

/** What a count's calls carried that breaks the rule a list and a read are held to. */
export const heldToTheRule = (where: string, c: { readonly calls: readonly Called[] }): string[] =>
  carriedNotAsHeldIn(where, c.calls);

/**
 * The counts of the panels, the openings inside their screens and presses, and the branches, on `company`: each count
 * opens twice on a device that has checked the company before and counts the second, and notes what the company held
 * when its calls were made, so what its reads asked is held at the company grown by what the company grew by.
 */
export const panelCountsOn = (company: CompanyOpened) => {
  const FOUNDER = founderOf(company);
  const inItsScreen = inItsScreenOn(company);
  /* What the company held when each count's calls were made, by the calls. */
  const HELD = new WeakMap<readonly Called[], CompanyHeld>();
  const heldWhen = (calls: readonly Called[]): readonly Called[] => {
    HELD.set(calls, company.held());
    return calls;
  };
  const counted = async (
    element: () => ReactElement
  ): Promise<{ reads: Reads; text: string; calls: readonly Called[] }> => {
    await openPanel(company, FOUNDER, element());
    const c = await openPanel(company, FOUNDER, element());
    return { reads: readsOf(c), text: c.text, calls: heldWhen(c.calls) };
  };
  /* What a count's reads asked at the grown company beyond the first size's count of the same kind, by call, held as `page` is where it names one. */
  const askedAtTwice = (
    where: string,
    was: { readonly calls: readonly Called[] },
    now: { readonly calls: readonly Called[] },
    page?: string
  ): string[] =>
    askedBeyondWhatGrew(
      where,
      was.calls,
      now.calls,
      [HELD.get(was.calls)!, HELD.get(now.calls)!],
      ['at the first size', 'grown'],
      page
    );
  /* The same for a press, which files records of its own: only the kinds its reads asked are held, not how many. */
  const pressAskedAtTwice = (
    where: string,
    was: { readonly calls: readonly Called[] },
    now: { readonly calls: readonly Called[] }
  ): string[] => askedKindsChanged(where, was.calls, now.calls, ['at the first size', 'grown']);
  /* What opening a panel in its screen read, and what pressing it read, on the company as it stands. */
  const countsInItsScreen = async (
    name: string
  ): Promise<{ readonly opened: ScreenCount; readonly pressed: ScreenCount }> => {
    const c = inItsScreen[name]!;
    servedAs(c.served ?? {});
    const steps: Step[] = [c.opens ?? seesTheRoot(c.root), joined(c.press)];
    const run = () => openScreenAnd(company, FOUNDER, c.page as never, c.params(), steps);
    await run();
    const [screen, looked, ...rest] = await run();
    /* A panel the page draws with the page reads what the page's opening read; its words are those the root shows. */
    heldWhen(looked!.calls);
    heldWhen(screen!.calls);
    return { opened: c.opens === null ? { ...screen!, text: looked!.text } : looked!, pressed: rest[rest.length - 1]! };
  };
  const branchCount = async (b: Branch): Promise<{ reads: Reads; text: string; calls: readonly Called[] }> => {
    servedAs(b.served);
    const params = b.params?.() ?? {};
    await openScreen(company, FOUNDER, b.page, params);
    const c = await openScreen(company, FOUNDER, b.page, params);
    return { reads: readsOf(c), text: c.text, calls: heldWhen(c.calls) };
  };
  return { counted, countsInItsScreen, branchCount, askedAtTwice, pressAskedAtTwice };
};
