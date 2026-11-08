// State-machine contract: the canonical state literals, the legal
// transition maps, and the validator/invariant helpers. The DB (`packages/db`)
// owns the column value domain via `pgEnum`; this module owns the transition
// semantics.

export * from './literals';
export * from './transitions';
