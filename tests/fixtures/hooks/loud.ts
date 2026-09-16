/**
 * Announces that it was imported. A module's top-level code runs the moment
 * `import()` resolves it, which is the thing the loader must not do until
 * every path in the list has been checked — so the loader's test needs a
 * module whose having-been-imported is observable.
 */
(globalThis as Record<string, unknown>).__landraceLoudHookLoaded = true;

export const nothing = null;
