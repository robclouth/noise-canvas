/**
 * Opens a compiled addon at an absolute path.
 *
 * The preload exposes these modules to the renderer, so `init()` can run in the
 * renderer process. `require()` resolves a path through `fs.realpathSync`, and
 * in a packaged renderer — a `file://` document — that throws `TypeError: no
 * access` for any path outside app.asar, which is exactly where the unpacked
 * addons live. Opening the library directly skips module resolution, so the
 * same call works in the main process, the renderer and the tests.
 */
export function loadNativeAddon<T>(path: string): T {
  const addonModule: { exports: T } = { exports: {} as T };
  process.dlopen(addonModule, path);
  return addonModule.exports;
}
