// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as kit from 'vaults-ui';

describe('the kit as the application reaches it', () => {
  /* RED WHEN: the application cannot import the select, the checkbox, the table or the copy control from the kit's name. */
  it('hands over the select, the checkbox, the table and the copy control', () => {
    const names = ['Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue', 'Checkbox', 'Table', 'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow', 'CopyText'];
    expect(names.filter((n) => (kit as Record<string, unknown>)[n] === undefined)).toEqual([]);
  });

  /* RED WHEN: the application cannot import the form field and its parts from the kit's name. */
  it('hands over the form field and its parts', () => {
    const names = ['Field', 'FieldContent', 'FieldDescription', 'FieldError', 'FieldGroup', 'FieldLabel', 'FieldLegend', 'FieldSeparator', 'FieldSet', 'FieldTitle'];
    expect(names.filter((n) => (kit as Record<string, unknown>)[n] === undefined)).toEqual([]);
  });
});
