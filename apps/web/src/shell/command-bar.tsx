import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Search01Icon } from '@hugeicons/core-free-icons';
import { Button, ComingSoon, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Kbd, useText } from 'vaults-ui';
import { LANGUAGES } from '../languages.js';
import { EVERY_PAGE, isBuilt, mayOpen, type Page, type PageId, type Text } from '../pages.js';
import { go } from '../router.js';
import { useSession } from '../session.js';
import { SHORTCUT, type ShortcutId } from '../shortcuts.js';
import { ShortcutKeys } from './shortcut-keys.js';

/**
 * THE COMMAND BAR: every page the person may open, found by its name in the
 * language shown or in English, and every command, with its shortcut. It is
 * opened by its shortcut or by the button at the top of every page, so a
 * browser that keeps the shortcut for itself still leaves a way in.
 */

/** A thing the command bar can run that is not a page. */
export interface Command {
  id: string;
  name: (t: Text) => string;
  words?: (t: Text) => string;
  shortcut?: ShortcutId;
  run: () => void;
}

/** One line of the command bar. */
interface Line {
  key: string;
  name: string;
  /** What it is found by: its name and words, in the language shown and in English. */
  found: readonly string[];
  shortcut?: ShortcutId;
  soon: string | null;
  run: () => void;
}

/** What stands in a phrase's gap for the keys, so the phrase is one whole string in every language and the keys are drawn where it puts them. */
const GAP = '\u0000';

/** A phrase with the keys drawn in its gap, wherever the language puts it. */
function WithKeys({ phrase, children }: { phrase: string; children: ReactNode }) {
  const [before, after] = phrase.split(GAP);
  return <>{before}{children}{after}</>;
}

/** The form text is compared in, so a search finds a word however its accents are written. */
const COMPARED = { form: 'NFKD' } as const;
const comparable = (s: string): string => s.normalize(COMPARED.form).replace(/\p{M}/gu, '').toLowerCase();

/** The English file's phrase for a key, whatever language is shown, so a page is also found by its English name. */
const ENGLISH = LANGUAGES[0]!.messages;
const english: Text = (key) => ENGLISH[key] ?? key;

/** Every line, for a viewer: the pages they may open, then the commands. */
export function linesFor(t: Text, pages: readonly (Page & { id: PageId })[], commands: readonly Command[], close: () => void): Line[] {
  const lines: Line[] = [];
  for (const p of pages) {
    const soon = isBuilt(p) ? null : (p.shows as { comingSoon: (t: Text) => string }).comingSoon(t);
    lines.push({
      key: p.id, name: p.name(t), soon, shortcut: p.shortcut as ShortcutId | undefined,
      found: [p.name(t), p.words?.(t) ?? '', p.name(english), p.words?.(english) ?? ''].map(comparable),
      run: () => { close(); go(p.id); },
    });
  }
  for (const c of commands) {
    lines.push({
      key: c.id, name: c.name(t), soon: null, shortcut: c.shortcut,
      found: [c.name(t), c.words?.(t) ?? '', c.name(english), c.words?.(english) ?? ''].map(comparable),
      run: () => { close(); c.run(); },
    });
  }
  return lines;
}

/** The lines a search finds: every word typed is in the line's name or words. */
export function found(lines: readonly Line[], search: string): Line[] {
  const words = comparable(search).split(/\s+/).filter((w) => w.length > 0);
  return lines.filter((l) => words.every((w) => l.found.some((f) => f.includes(w))));
}

export function CommandBar({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (open: boolean) => void; commands: readonly Command[] }) {
  const t = useText();
  const { viewer } = useSession();
  const [search, setSearch] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();
  const close = (): void => { onOpenChange(false); setSearch(''); setAt(0); };
  const pages = EVERY_PAGE.filter((p) => mayOpen(p, viewer));
  const lines = useMemo(() => found(linesFor(t, pages, commands, close), search), [t, pages.length, commands, search]);
  const chosen = Math.min(at, Math.max(lines.length - 1, 0));

  /* Moving through the list and choosing from it, while the search box has the focus. These keys belong to the list, not to the application's shortcuts. */
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((chosen + 1) % Math.max(lines.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((chosen - 1 + lines.length) % Math.max(lines.length, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); lines[chosen]?.run(); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(true); }}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg" showCloseButton={false} data-command-bar>
        <DialogTitle className="sr-only">{t('commandBar.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('commandBar.description')}</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4 text-muted-foreground" />
          <Input
            autoFocus value={search} onChange={(e) => { setSearch(e.target.value); setAt(0); }} onKeyDown={onKey}
            placeholder={t('commandBar.placeholder')} aria-label={t('commandBar.title')}
            role="combobox" aria-expanded={true} aria-controls={listId} aria-activedescendant={lines[chosen]?.key}
            className="h-11 border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <ul id={listId} role="listbox" aria-label={t('commandBar.title')} className="max-h-80 overflow-auto p-1">
          {lines.length === 0 ? <li className="p-3 text-sm text-muted-foreground" data-nothing-found>{t('commandBar.nothingFound')}</li> : null}
          {lines.map((l, i) => (
            <li
              key={l.key} id={l.key} role="option" aria-selected={i === chosen} data-line={l.key}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              onMouseMove={() => setAt(i)} onClick={() => l.run()}
            >
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
              {l.soon === null ? null : <ComingSoon explanation={l.soon} />}
              {l.shortcut === undefined ? null : <ShortcutKeys id={l.shortcut} />}
            </li>
          ))}
        </ul>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground" data-command-bar-way-in>
          <WithKeys phrase={t('commandBar.wayIn', { keys: GAP })}><ShortcutKeys id={SHORTCUT.commandBar} /></WithKeys>
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** The command bar's button, at the top of every page: the way in for a person who does not use the shortcut, or whose browser keeps it. */
export function CommandBarButton({ onOpen }: { onOpen: () => void }) {
  const t = useText();
  return (
    <Button variant="outline" size="sm" onClick={onOpen} className="gap-2 text-muted-foreground" data-action="open-command-bar">
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
      <span>{t('commandBar.button')}</span>
      <Kbd><ShortcutKeys id={SHORTCUT.commandBar} bare /></Kbd>
    </Button>
  );
}

