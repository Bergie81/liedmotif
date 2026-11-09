// What the chat panel may follow in an answer, for one user (server-only: the
// docs pages come from the snapshot). The app pages are the same role's list
// the system prompt carries, so the model is never told of a page the panel
// would refuse, nor the other way round.

import type { UserRole } from '@liedmotif/db';
import type { AnswerLinkTargets } from './answer-links';
import { loadDocs } from './docs';
import { appRoutesFor } from './route-map';

export function answerLinkTargets(role: UserRole): AnswerLinkTargets {
  return {
    appPaths: appRoutesFor(role).map(({ path }) => path),
    docsPages: docsPageSlugs(),
  };
}

/** A snapshot that cannot be read costs the docs links, not the page asking for them. */
function docsPageSlugs(): string[] {
  try {
    return loadDocs().map(({ slug }) => slug);
  } catch {
    return [];
  }
}
