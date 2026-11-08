export function readBrowserPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeBrowserPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The in-memory visual state remains authoritative when persistence is unavailable.
  }
}

export function removeBrowserPreference(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage that cannot be reached cannot hand the value to anyone either.
  }
}
