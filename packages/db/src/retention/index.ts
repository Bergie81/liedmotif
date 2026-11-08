// Retention decisions for the append-only event tables — one module so the
// per-table rule and the code enforcing it can never drift apart.

export * from './event-retention-repo';
