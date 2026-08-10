# Noise Canvas

**Photoshop for sound.** v1.0

Noise Canvas is a standalone tool for doing sound design. It loads audio files, shows them as **spectrograms**, and lets you paint transformations and effects directly onto the sound — in beats and semitones, not samples and Hz.

![Noise Canvas Screenshot](./images/screenshot.jpeg)

## 📖 [Read the manual →](./docs/manual.md)

Or just open it up and play around. All the parameters have got tooltips. I'm of the belief that how to use a tool should be mostly obvious just by using it. If it's not then I need to fix something.

---

## What it does

- **Paint on spectrograms.** Brushes stamp effects across time and pitch, snapped to a musical grid and scale.
- **13 spectral effects** — dynamics, transform, overtones, blur, clone, synthesize, evolve, binaural, sort, transmute, waveshape, convolve, align — stackable and reorderable, several instances at a time.
- **Multi-step brushes** with four macros, a preset library, and hotkeys.
- **Deep modulation** — three per-pixel 2D modulators (patterns, procedural textures, your own images, envelope follower, sequencer), plus macros, pen pressure/tilt, and contextual sources.
- **Branching history** that survives restarts, with favorites and per-branch audio export.
- **Stem splitting** — harmonic/percussive, NMF, or AI separation — with lossless merge back.
- **Runs inside Ableton Live** as a Live 12 extension — right-click a clip, edit, render back into the set. Also works as an external sample editor, and syncs over Ableton Link.

Everything runs on the GPU and resynthesizes after every stroke, so you hear the real audio immediately.

---

## Getting Started

Download the build for your platform from [**Releases**](../../releases). macOS (Apple Silicon and Intel), Windows, and Linux are all published.

Open an audio file (or drag one onto the window), paint on its spectrogram, and hear the results instantly.

Supported formats: `wav`, `mp3`, `ogg`, `flac`, `m4a`, `aac`, `wma`, `aiff`, `ape`, `wv`, `mka`.

> **First launch takes a while.** Every shader is compiled and warmed before you can paint, with an "Optimizing shaders…" progress bar. This only happens once per install (and after driver updates).

### Important: Code Signing, Certificates, and "Scary" OS Warnings

Noise Canvas is **free software** — and that means I'm not paying for expensive signing certificates.

When software is "properly signed," it's linked to a digital certificate that tells your operating system _exactly who built it_.
Those certificates cost money and for a free app, I'm just not going to do that soz.

So basically Noise Canvas is **unsigned**, which means your OS will complain the first time you open it.
You'll need to manually approve it once — after that, it'll open normally.

**On Windows**

1. When you first open the installer or `.exe`, Windows will show a warning like "Windows protected your PC" or "Unknown publisher."
2. Click **More Info**.
3. Then click **Run Anyway** or **Open Anyway**.

That's it — the app will launch. Windows will remember your choice for next time.

**On macOS**

1. Try to open the app normally. macOS will block it and say it's from an unidentified developer.
2. Go to **System Settings → Privacy & Security**.
3. Scroll down to the **Security** section.
4. You'll see "Noise Canvas was blocked from opening" with an **Open Anyway** button. Click that.
5. macOS will ask again; confirm with **Open Anyway**.

After that, it'll open fine forever.

If you trust me — great! If you don't, I'm not exactly anonymous. If Noise Canvas does something dodgy you can trash me on instagram. Also the code is visible to all so you can see I'm not doing anything bad.

Eventually I might pay for a certificate and sign the binary properly, but for now you'll just have to live with it if you want those sick spectral sounds. Sorry!

One knock-on effect: **the app can't update itself.** To upgrade, download the new build from Releases and replace your copy — the same one-time approval applies to the new version.

---

## Ableton Live

There are three ways to use Noise Canvas with Live, and they stack.

### The Live extension (beta)

Noise Canvas ships as an **Ableton Live 12 extension** — the whole editor, embedded inside Live. Every release attaches a `noise-canvas.ablx` alongside the app builds.

1. Install the `.ablx` (Live 12 Suite, with Extensions support).
2. Right-click any audio clip → **Edit in Noise Canvas**.
3. The clip opens in the editor, warp settings and all.
4. Paint, then render straight back into the set as a new clip — no exporting, no file juggling.

The history panel also gets **Export branch to Live**, which drops every state along a branch into the set as separate clips. Handy for auditioning variations in context.

> Still beta: it needs a Live build with Extensions support, and Live's extension support is itself in beta. The standalone app is the stable route.

### As an external sample editor

Works with any Live version:

1. **Live Preferences → File/Folder** → set **Noise Canvas** as your _External Sample Editor_.
2. Right-click a sample in Live → **Edit**.
3. Edit, save, close — Live reloads the updated version automatically.

### Ableton Link

Enable **Link** in the transport bar to lock tempo and start/stop to Live (or anything else Link-enabled on the network), whichever of the above you're using. Right-click the Link button for latency compensation.

Full details in the [manual](./docs/manual.md#working-with-ableton-live); build and dev-run instructions in [`src/extension/README.md`](./src/extension/README.md).

---

## Technical Overview

- **Electron**, **TypeScript**, and **React**, with **Zustand** for state and **Mantine** for UI.
- **React Three Fiber** / **Three.js** for rendering: a single shared WebGL canvas hosts a viewport per open file.
- All DSP runs on the GPU as **GLSL shaders**, ping-ponging between float FBOs. The brush, effect chain, blending, and modulation are all one render graph. Shaders are precompiled and warmed on a worker at startup so the first stroke isn't a freeze.
- Analysis and resynthesis are handled by a native addon around **[Gaborator](https://gaborator.com/)**, which implements the Constant-Q Transform. The same addon does HPSS, NMF, spectrogram merging, ONNX-based AI separation, and the true-peak limiter.
- Audio decoding via **ffmpeg**; playback via **Tone.js**; tempo sync via **Ableton Link**.
- Complex coefficients are stored as magnitude/phase pairs at full 32-bit float precision, with phase unwrapped along time per band.

Why Constant-Q rather than FFT: it adjusts time resolution based on frequency — low frequencies get accurate pitch, high frequencies get accurate timing. That matches human hearing and avoids the artificial "FFT sound," producing more natural transients and harmonics.

---

## Status

v1.0 is the first release I'd call finished rather than in-progress. It's still a solo project though, so stability is not guaranteed — issues will be tracked and fixed when I can be arsed.

Current tasks, bugs, and ideas live here:
[https://trello.com/b/P2vcaaZI/noise-canvas](https://trello.com/b/P2vcaaZI/noise-canvas)

---

## Contributing

Contributions are welcome with caveats.
If you want to add features or improvements, reach out first so we can align on direction.
You're also free to fork it and take it your own way — but on the main fork, I'll have final say.

---

## Building

### macOS / Linux

```bash
git clone <repo>
cd noise-canvas
npm i
npm run dev
```

### Windows

Install Node.js and make sure **native build tools** are included.
Then open _Visual Studio Installer_ and ensure **Windows 11 SDK** is selected under Build Tools.

Finally:

```bash
npm i
```

That should work. Probably. God I hate Windows.

### Useful scripts

```bash
npm run dev            # run the app
npm run build          # typecheck + build
npm run build:mac      # or :win / :linux — packaged distributables
npx node-gyp rebuild   # rebuild the native Gaborator addon after C++ changes

npm run test:run       # renderer / WebGL suite (Vitest + Playwright)
npm run test:addon     # native addon tests
npm run test:host      # extension host tests
npm run test:perf      # painting performance suite
npm run typecheck
npm run lint
```

### Ableton extension

```bash
npm run ext:run        # build and launch inside Live (dev)
npm run ext:package    # produces out-ext/noise-canvas.ablx
```

See [`src/extension/README.md`](./src/extension/README.md).

---

## Credits

- [3dtextures.me](https://3dtextures.me/) – for the textures
- [Gaborator](https://gaborator.com/) – for spectral analysis
- [htdemucs](https://huggingface.co/smank/htdemucs-onnx) – for AI stem separation (CC-BY-NC 4.0)
- Tomas Boroski – for the amazing icon ([github](https://github.com/tomasborosko), [instagram](http://instagram.com/fivesteppath))

---

## License

Noise Canvas uses the GNU Affero General Public License v3 (AGPL-3.0).
See [LICENSE.md](./LICENSE.md) for the full text.

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but without any warranty; without even the implied warranty of
merchantability or fitness for a particular purpose.

In short:
You can use, study, share, and modify this software freely.
If you distribute it or run it publicly, you must share your source under the same license.

**© 2025 Rob Clouth**
