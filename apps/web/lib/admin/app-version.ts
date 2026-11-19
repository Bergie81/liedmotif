import manifest from '../../../../package.json';

// Web and worker ship as one release, so the product version is the root
// workspace manifest's — a per-workspace version would only report the part of
// the stack this process happens to be. Bundlers inline the JSON at build time,
// which is what makes the value correct inside the standalone Docker image too.
export const APP_VERSION: string = manifest.version;
