// Error taxonomy for the analysis pipeline.

/**
 * A PERMANENT analysis failure: the input itself violates a guard (oversize,
 * over-duration) or is undecodable in a way retries cannot fix. The analyzer
 * converts these into a `failed` provenance write instead of letting Graphile
 * burn retries on a deterministic outcome.
 */
export class AnalysisInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisInputError';
  }
}

/**
 * A HOST-RESOURCE shortage (temp disk full, no headroom): nothing is wrong
 * with the input, the host just can't measure it right now. Retried like any
 * transient error; when retries run out, the job records `unavailable` — the
 * same "this host can't measure" provenance the ffmpeg-less path uses — so the
 * boot-probe reanalysis path reopens the track once the host recovers,
 * instead of `failed` parking it at the current analyzer version forever.
 */
export class AnalysisResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisResourceError';
  }
}
