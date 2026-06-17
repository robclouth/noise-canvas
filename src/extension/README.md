# Noise Canvas — Ableton Live extension

A second build of the Noise Canvas core (`src/renderer/src`) packaged as an
Ableton Live 12 Suite extension, alongside the existing Electron app. Both shells
share the renderer; only the host facade differs (`@host-impl` alias).

## Layout

- `webview/` — the editor UI, built by `vite.extension.config.ts` to
  `out-ext/webview/`. `@host-impl` resolves to the extension host implementation
  (`src/renderer/src/lib/host/extension.ts`).
- `host/` — the Node extension host loaded by Live. `main.ts` registers the
  "Edit in Noise Canvas" AudioClip context-menu action and brokers the edit;
  `server.ts` is the localhost data plane that serves the webview and streams
  audio both ways; `session.ts` is the per-edit store.
- `manifest.json` — extension manifest; `entry` points at the bundled host,
  resolved relative to `out-ext/`.
- `vendor/` — the off-registry SDK + CLI tarballs, installed as `file:`
  dependencies (the SDK is a closed beta, not on npm).

## Build

`npm run build:ext` builds the webview then bundles the host, assembling the
loadable extension under `out-ext/` (`manifest.json` + `host/main.cjs` +
`webview/`).

## Run in Live (dev)

Requires Live 12.4.5b+ Suite with **Preferences → Extensions → Developer Mode**
enabled. Point the CLI at the running Live instance via a `.env`
(`EXTENSION_HOST_PATH=…`) or `extensions-cli run --live "<Live.app>"`.

```
npm run ext:run        # build:ext, then extensions-cli run from out-ext/
```

Right-click an arrangement audio clip → **Edit in Noise Canvas**.

## Package

```
npm run ext:package    # produces out-ext/noise-canvas.ablx
```

## Status / open validations

The localhost data plane is covered by `npm run test:host`. Two things can only
be confirmed against the Live beta: that `createAudioClip` honours a co-located
`.asd` sidecar to preserve warp markers, and that the concurrent create+delete
in `withinTransaction` swaps the clip in one undo step (vs. needing a sequential
delete-then-create). The webview still loads the build-pipeline smoke test, not
the full editor surface.
