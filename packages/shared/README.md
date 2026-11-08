# @liedmotif/shared

The lowest-level workspace package: framework-free, dependency-light utilities and
contracts consumed as TypeScript source by both `apps/web` and `apps/worker`. It
must **not** import React, Next, or any package above it.

## Surface

- **Utilities:** `logger` (+ redaction), `env`, `text`, `hash`, `rate-limit`.
- **State-machine contracts** (`src/state-machines/`): the canonical state literals,
  legal-transition maps, `canTransition`/`assertTransition`, the track retention
  class, and the cross-machine session invariants for the four machines
  (`activitySessionStatus`, `queueItemState`, `providerNormalizedStatus`,
  `trackStatus`).
- **API contracts** (`src/contracts/`): strict Zod request/response schemas +
  inferred types for the 13 core endpoints, the `API_CONTRACTS` registry, the
  shared error envelope, and the contract domain vocabularies.

The DB `pgEnum`s (`packages/db`) stay the column **value domain**; this package owns
the **transition semantics** and contract vocabularies. Parity tests in
`packages/db` bind the two so they can't drift (and `db:generate` stays clean).
The source files and their tests are the authoritative reference.
