// `readDocs`: the one tool the Assistant's model has. It loads a single section
// of the user docs, so a turn carries the few sections it needs instead of every
// page.

import type { LlmTool } from '@liedmotif/providers';
import { readDocsInputSchema, type ReadDocsInput } from '@liedmotif/shared';
import { readDocsSection, type DocsPage } from './docs';

export const READ_DOCS_TOOL_NAME = 'readDocs';

/**
 * What one turn may read, in characters: the 6k tokens of a 16k-token context
 * that belong to docs sections, at 3.5 characters per token. Any single section
 * fits; this bounds several read in a row, or several asked for at once.
 */
export const SECTIONS_READ_CHAR_BUDGET = 21_000;

/** The tool for ONE turn: it counts what that turn has read against the budget. */
export function createReadDocsTool(pages: readonly DocsPage[]): LlmTool<ReadDocsInput> {
  let read = 0;
  return {
    name: READ_DOCS_TOOL_NAME,
    description:
      'Read one section of the Liedmotif user docs. Pick the page and the section from the docs index.',
    inputSchema: readDocsInputSchema,
    async execute({ page, section }) {
      const lookup = readDocsSection(pages, page, section);
      if (!lookup.found) {
        return lookup.reason === 'unknown-page'
          ? `There is no page "${page}". The pages are: ${lookup.pages.join(', ')}.`
          : `The page "${lookup.page}" has no section "${section}". Its sections are: ${lookup.sections.join('; ')}.`;
      }
      if (read + lookup.markdown.length > SECTIONS_READ_CHAR_BUDGET) {
        return 'That section is more than you can still read for this answer. Answer from what you have read.';
      }
      read += lookup.markdown.length;
      return lookup.markdown;
    },
  };
}
