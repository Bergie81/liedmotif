// `readDocs`: loads a single section of the user docs, so a turn carries the
// few sections it needs instead of every page.

import type { LlmTool } from '@liedmotif/providers';
import { readDocsInputSchema, type ReadDocsInput } from '@liedmotif/shared';
import { readDocsSection, type DocsPage } from './docs';
import { READ_DOCS_TOOL_NAME } from './tool-names';

export function createReadDocsTool(pages: readonly DocsPage[]): LlmTool<ReadDocsInput> {
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
      return lookup.markdown;
    },
  };
}
