# Onboarding & Documentation — Plan

How someone goes from opening Noise Canvas for the first time to knowing what it
can do, and how that stays true as the app changes.

**Status:** Phase 0 is on disk and **uncommitted**. Phases 1–5 are agreed in
shape, not written. Eleven of the twelve decisions in §6 are settled — only
**D5** (where tour copy is authored) is still open, and nothing is blocked on it.

## The help surfaces at a glance

Where a user can get help, and what triggers each. Everything below Phase 0 is
planned, not built.

| Surface               | Trigger                                                        | Scope                             | Phase |
| --------------------- | -------------------------------------------------------------- | --------------------------------- | ----- |
| **Parameter tooltip** | Hover a control, 1 s delay                                     | One parameter                     | built |
| **First-run tour**    | Auto-offered on first launch; **Help → Run Walkthrough** after | The whole app, once               | built |
| **`?` overlay**       | `?` button and `?` key                                         | Outlines every area at once       | 4     |
| **Deep tour**         | Click an area in the overlay                                   | One area, runs straight through   | 4     |
| **Recipes**           | From the overlay's area entry, or `docs/recipes.md`            | One task, start to finish         | 5     |
| **Manual (in-app)**   | Help menu; parameter label menu → deep link                    | Reference, bundled with the build | 3     |
| **README**            | GitHub                                                         | What it is, install, related work | built |

The one-line version: **hover for a parameter, `?` for the room you're in, the
tour for the whole app, recipes for a task, the manual for everything.**

---

## 1. Goal

Three tiers of learning, each answering a different question, each read in a
different mode:

| Tier            | Question             | Read               | Lives in                          |
| --------------- | -------------------- | ------------------ | --------------------------------- |
| **Walkthrough** | Where is everything? | Once, on first run | `lib/walkthrough.ts`              |
| **Recipes**     | How do I do X?       | Returned to often  | `docs/recipes.md` _(not written)_ |
| **Manual**      | What does this do?   | Looked up          | `docs/manual.md`                  |

Plus the README as the shop window, and per-parameter tooltips already in the
app as the zeroth tier.

**The design constraint that shapes everything below:** these tiers describe the
same UI, so they must not become independent sources of truth that drift apart.
The answer is a single registry of UI areas that all of them derive from — see §3.

**Non-goals.** Not a video tutorial. Not in-app help text duplicating the manual.
Not a deep tour for every area — see the scope discipline note in Phase 4.

---

## 2. Current state — Phase 0 (built, uncommitted)

### 2.1 README split into README + manual

**`README.md`** (257 lines) is a landing page: tagline, screenshot, prominent
manual link, "What it does" feature list, a user-facing **How it works**,
install and code-signing warnings, **Ableton Live**, a dev-facing **Technical
Overview**, status, contributing, building, **Related Projects**, credits,
licence.

The two-audience split is deliberate and was iterated on:

- **How it works** is for someone deciding whether they want this. Two subsections
  — _Phase is not thrown away_ (why picture-only spectral tools sound smeared, why
  every cell carries magnitude and phase for L and R, and why that produces the
  Warp Algorithm control) and _Time is beats, pitch is semitones_ (what Constant-Q
  buys you, framed as experience rather than implementation).
- **Technical Overview** is for contributors: Zustand/Mantine, one shared canvas
  with a viewport per file, FBO ping-pong as one render graph, worker shader
  warmup, the addon's full job list, ffmpeg/Tone.js/Link, and the RGBA32F
  requirement _with the reason it's load-bearing_ — accumulated phase doesn't
  survive half-float, so it isn't an optimisation target.

**Related Projects** — MetaSynth, Virtual ANS, Photosounder, HighC, iZotope RX,
SpectraLayers. Framed as neighbours worth your time, not as influences and
explicitly not as justification for this app existing. All six links verified 200.

**`docs/manual.md`** (587 lines) holds the reference: Core Concepts, The
Interface, Brushes, Effects, Modulation, Parameter Controls, Working with Files,
History, Transport and Output, Menus, Keyboard Shortcuts, Where Things Are Saved,
Working with Ableton Live.

Written from source (`parameters.ts`, `constants.ts`, the effect modules, the
shaders, the store slices, `menu.ts`, `useShortcuts.ts`) rather than from the old
README, then corrected against a live capture run. Corrections that came out of
that: source picking is Shift+click not Ctrl+click; the old "Presets and Quick
Slots" section described a system that no longer exists; `MAX_EFFECTS = 10` per
step; the time legend sits below the spectrogram; pitch zoom happens by dragging
the pitch legend; `displayMinDb` / `displayMaxDb` / `magnitudeLimit` / `minFreq`
have no UI at all.

### 2.2 UI anchors

**`src/renderer/src/lib/ui-anchors.ts`** — the single source of truth:

```ts
UI_ANCHORS; // 14 region names, const tuple
UiAnchor; // union derived from it
EffectAnchor; // `effect-${EffectType}` template type
anchorProps(name); // spread onto a component
anchorSelector(name); // "[data-anchor=…]"
```

Tagged across 10 components: three layout columns (`brush-panel`, `sidebar`,
`transport`), `file-lane`, `file-header`, the Steps strip, six brush-panel
sections, both sidebar sections, and effect cards keyed by effect type. `Section`
gained an optional `anchor` prop; `EffectSection` gained `effectType`.

Renaming an anchor is a compile error at every use site. That is the point.

### 2.3 Screenshot capture script

**`scripts/capture-ui.mjs`** launches the built app in Electron via Playwright,
drives it into a known state, and writes one PNG per target to
`docs/images/ui/`. **20/20 targets pass**, including transient UI (Add Effect
modal, brush picker, parameter menu) which it opens itself.

```
node scripts/capture-ui.mjs                          # all targets
node scripts/capture-ui.mjs --list
node scripts/capture-ui.mjs --only=section-effects,transport
node scripts/capture-ui.mjs --build
```

Two deliberate behaviours:

- **Deterministic runs.** Wipes `Local Storage` / `Session Storage` /
  `WebStorage` / `history` from its scratch userData each run so the brush list
  and open files start from defaults, but keeps `GPUCache` so shader warmup stays
  warm. Without this the _second_ run fails — the first run's persisted brush
  leaks into the sidebar and the modal locator matches the copy behind the overlay.
- **Anchor drift guard.** Validates every target against the names actually
  declared in `ui-anchors.ts` and `EFFECT_KEYS` before launching, so a rename
  stops the run instead of silently producing 19 screenshots.

It currently writes **PNG** — 20 files, 1.1 MB. These are regenerated wholesale
every time the UI changes, so each run is a fresh 1.1 MB of git history that
never compresses away. They need to be **WebP** instead; see Phase 1.

### 2.4 First-run walkthrough

**driver.js 1.8.0** — MIT, zero runtime dependencies, ~5 KB gzipped, in
`devDependencies` (this repo bundles renderer libs; React, Mantine and Three are
all devDeps, so leaving it in `dependencies` would ship it into the package for
nothing).

Chosen over Shepherd.js (more machinery than 11 steps needs), react-joyride
(~34 KB, becomes something you orchestrate once tours get conditional), and
intro.js (dual AGPL/commercial — compatible today but forecloses relicensing).

| File                                          | Role                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `src/renderer/src/lib/walkthrough.ts`         | the 11 steps, the two gates, `startWalkthrough()`                         |
| `src/renderer/src/components/walkthrough.tsx` | first-run prompt + `ipcOn("run-walkthrough")`; renders nothing            |
| `src/renderer/src/assets/walkthrough.css`     | Mantine-dark theming + two critical overrides (§4.1)                      |
| `store/app.ts`                                | `walkthroughSeen` in `APP_PERSISTED_KEYS`                                 |
| `main/lib/types.ts`                           | `run-walkthrough` renderer event                                          |
| `main/lib/menu.ts`                            | **Help** menu on every platform (was macOS-only) with **Run Walkthrough** |

**The 11 steps:**

| #   | Step                                                  | Anchor               | Advance                   |
| --- | ----------------------------------------------------- | -------------------- | ------------------------- |
| 1   | Welcome to Noise Canvas                               | — (centred)          | Next                      |
| 2   | This is your sound (axes + **colour = stereo image**) | `file-lane`          | Next                      |
| 3   | This is your brush                                    | `brush-panel`        | Next                      |
| 4   | Give it something to do — add Blur                    | `section-effects`    | **gated: effect added**   |
| 5   | Decide where it lands                                 | `section-envelope`   | Next                      |
| 6   | Now paint                                             | `file-lane`          | **gated: stroke painted** |
| 7   | Hear it                                               | `transport`          | Next                      |
| 8   | Nothing is lost                                       | `section-history`    | Next                      |
| 9   | Start from a preset                                   | `section-brushes`    | Next                      |
| 10  | Make it move                                          | `section-modulators` | Next                      |
| 11  | That's the tour                                       | `brush-panel`        | Done                      |

Steps 4 and 6 are interactive because the default brush ships with
`DEFAULT_EFFECTS = []` — on a genuine first run the Effects section is empty, so
step 4 would otherwise spotlight a blank box. Making the user add the effect
themselves means that by step 6 they have built a working brush by hand.

Gating uses `showButtons: ["close"]` to remove Next, plus a Zustand subscription
that calls `moveNext()` when the active step gains an effect, or when
`isStroking` goes true→false.

Step 2's colour claim is verified against `display.frag:86-98`: left is
`(1, 0.5, 0)` orange, right is `(0, 0.5, 1)` azure, equal channels sum to grey.
Grey means _equal in both channels_ — which includes a mono file **and** centred
content in a stereo file — so the copy says "equal in both" rather than "mono".

### 2.5 Verification already done

Driven against the real app end to end, **15/15 checks**: welcome modal appears,
Show me starts the tour, demo file auto-loads, Next advances, gated step 4 hides
Next, adding an effect advances it, gated step 6 waits, painting advances it, the
remaining steps reach the end, Done closes, `run-walkthrough` IPC restarts it, the
Help menu item exists, and the prompt does **not** reappear on a second launch.

Also `npm run typecheck` clean both sides, `npm run test:run` **224 passed**, lint
clean in the new files (7 pre-existing warnings elsewhere).

The temporary harnesses were deleted. Gotchas if one is recreated:

- Delete `ELECTRON_RUN_AS_NODE` from the launch env — Electron hosts export it and
  it makes the child run as plain Node.
- Wait on `!document.querySelector("[class*='LoadingOverlay-root']")` for shader
  warmup, up to ~5 min cold.
- `bundled://` paths resolve under `process.resourcesPath`, which for an
  unpackaged run is inside `Electron.app/Contents/Resources`. Symlink
  `resources/samples` there to test the demo-file path, and **remove the symlink
  afterwards**.
- Playwright's `.count()` counts hidden nodes — use `.isVisible()` when asserting
  a button is gone.

---

## 3. The architecture the rest of the plan depends on

`ui-anchors.ts` grows from a list of names into an **area registry**, where each
entry carries:

```
anchor         → spotlight target + screenshot crop   (exists today)
title + blurb  → overlay label
deepTour?      → steps for that area
manualSection  → heading id in docs/manual.md
recipes?       → related entries in docs/recipes.md
```

One registry then feeds **five** consumers: the first-run tour, the
discoverability overlay, the deep tours, the screenshot manifest, and the manual
cross-links. This is the thing that stops these features becoming three sources of
truth, and everything in Phases 2–5 assumes it.

**Two kinds of content, not one:**

- **Areas** — Steps, Modulators, History, Source, Effects. Own an anchor.
- **Techniques** — double-click a label to reset, shift-drag to snap to preset
  values, the ⋮ randomise menu (amount + Include Mod.), assigning letter keys to
  brushes, right-clicking Link for latency compensation. These apply to _every
  parameter row in the app_ and own no anchor; they name one to demonstrate _on_.

If only areas are modelled, the randomisation and reset material has nowhere to
live — which is most of what a returning user still doesn't know.

---

## 4. Defects

### 4.1 Fixed

**driver.js blocked the Add Effect modal.** driver.js's own stylesheet sets
`.driver-active * { pointer-events: none }` and re-enables only the spotlit
element's subtree. Mantine portals modals to `<body>`, which is never in that
subtree — so at step 4 a user could click "Add effect", watch the modal open, and
be unable to click Blur. The tour dead-ended on its own instruction. Fixed in
`walkthrough.css` by re-enabling pointer events on `[data-portal="true"]`, and
dropping the overlay to `z-index: 500` so modals render at full contrast instead
of dimmed.

### 4.2 Open — blocks shipping the walkthrough

**`file-lane` is not a unique anchor; the tour breaks with multiple files open.**
Every other anchor is on a singleton region, but `file-lane` is per-file.
`anchorSelector()` yields a plain CSS string, driver.js passes it to
`querySelector`, and that returns the **first** match — so with three files open
the tour spotlights lane #1 regardless of which file is active or where the canvas
is scrolled. Steps 2 and 6 then point at the wrong thing.

**D1 sidesteps this rather than solving it.** Because the tour now always opens
the demo file and scrolls to it, it always means the lane it just created — so
no per-instance anchor model is needed for the walkthrough. The underlying
non-uniqueness stays true, and will need a real answer if anything else ever has
to point at a specific lane.

### 4.3 Open — documentation accuracy

**Transmute and Waveshape are hidden from the Add Effect picker.**
`HIDDEN_EFFECTS = new Set(["transmute", "waveshape"])` in `modals.tsx:9`. They
still work in brushes that already use them but cannot be added from the UI. Per
D2 they stay hidden and come out of the README; the count drops to **11 spectral
effects**. They keep their manual sections, since a brush can still contain them.

**Onset features are undocumented.** There is an **Onsets** sensitivity control in
the file header, an **"Onsets"** value on `gridSizeBeats` that snaps stamps to
detected hits, and onset markers drawn on the spectrogram. Per D7 these are
settled and get documented in Phase 1. The warp-algorithm table is already
correct and needs nothing.

### 4.4 Open — pre-existing, out of scope but documented

**The updater IPC is half-built.** `preload/index.ts:33-37` exposes
`checkForUpdates` / `downloadUpdate` / `quitAndInstall` via `ipcRenderer.invoke`,
but there is **no `ipcMain.handle`** for any of those channels anywhere in
`src/main/`. `update-downloaded` and `download-progress` exist only as type
declarations. So the Download button can only reject, and nothing checks at
startup — `autoUpdater.checkForUpdates()` is called only from the two menu items.
Separately, macOS auto-update cannot work at all: `mac.identity: "-"` is ad-hoc
signing, and Squirrel.Mac validates the downloaded bundle against the running
app's designated requirement, which for an ad-hoc signature is cdhash-based and
changes every build. The manual and README now say updates are manual, which is
the honest description of the shipped behaviour.

**Startup console error:** `"The file does not contain a valid audio stream or is
corrupted"`. Confirmed unrelated to the walkthrough — it fires with the tour
declined and zero files open. Appears alongside an HRTF `ENOENT` that is
definitely an unpackaged-run artifact, so the two may share a root cause.

---

## 5. Phased plan

### Phase 1 — Ship what exists _(unblocked)_

The smallest set of work that makes Phase 0 committable.

1. **Always open the demo file** at tour start (D1), and scroll to it whether it
   was already open or not. This also dissolves the `file-lane` uniqueness bug
   from §4.2: the tour no longer has to work out _which_ lane it means, because
   it owns the one it just opened. `startWalkthrough()` currently opens the demo
   only when `openFileIds.length === 0` — that condition goes, and a
   scroll-into-view of the demo lane replaces it.
2. **Remove Transmute and Waveshape from the README** (D2) — the count becomes
   **11 spectral effects** and the two names come out of the list. They stay
   hidden in the picker, keep working in brushes that already use them, and keep
   their manual sections.
3. **Document the onset features** (D7) — the file-header **Onsets** sensitivity
   control, the **"Onsets"** value on `gridSizeBeats`, and the onset markers drawn
   on the spectrogram. All three are settled enough to write down.
4. **Rewrite tour steps 1 and 2.** Details below.
5. **Drop the Init preset; make New brush create an empty brush** (D12).
6. **Emit WebP instead of PNG** from `capture-ui.mjs`, and delete the committed
   PNGs. Details below.
7. Re-run: `npm run typecheck`, `npm run test:run`, `node scripts/capture-ui.mjs`,
   and one manual cold launch with a fresh userData.

No version bump (D8) — `package.json` stays at `0.1.17`. The demo file stays
`bundled://pad-loop.mp3` (D10). Punchy needs nothing (D9).

**Done when:** the tour opens and scrolls to the demo file with 0, 1 and 3 files
already open; the capture script is 20/20 and writes `.webp`; no `.png` remains
under `docs/images/ui/`; and no claim in the README or manual describes behaviour
the build doesn't have.

#### Tour steps 1 and 2

**Step 1 — the welcome.** The current copy is generic product prose ("This is a
spectrogram editor: you paint effects straight onto the picture of a sound…").
Replace it with something in Rob's voice, first person, that does three things:
introduces the app as a tool for **spectrally destroying samples**, admits the
tool is _meant_ to be intuitive, and offers the walkthrough as the bridge for
where it isn't. Roughly:

> Hey, it's Rob. Welcome to Noise Canvas — a tool for spectrally destroying
> samples. I've tried to make it as intuitive as I can, but a few things are
> easier shown than found. This should make it a bit less mysterious.

The self-aware note is the point: it says out loud that discoverability is the
known weak spot, which is the same admission the README already makes ("how to
use a tool should be mostly obvious just by using it — if it's not then I need to
fix something").

**Step 2 — the canvas.** Currently covers the axes and the stereo colouring only.
It also needs **how to move around**, which is otherwise close to undiscoverable —
pitch zoom lives on the legend, not the canvas, and vertical scroll on the
spectrogram scrolls the _file list_ rather than the file, which is actively
surprising. From the manual's Navigating the Canvas section, the three that
matter for a first run:

- **Right-click drag** to pan in time.
- **`Cmd`/`Ctrl` + scroll**, or pinch, to zoom in time around the cursor.
- **Drag the pitch legend** left/right to zoom in pitch, up/down to scroll it.

That is more than one popover comfortably holds alongside the axes and the colour
key. Splitting it into two steps — _what you're looking at_ (beats across,
semitones up, brightness is loudness, orange/blue is the stereo image) then
_how to move around it_ — takes the tour to 12 steps, which is the better trade.

#### Dropping the Init preset

`factoryPresets[0]` in `lib/factory-presets.ts` is **Init** — one step, no
effects, i.e. an empty brush shipped as a preset. It exists only because the
**New brush** button doesn't make a brush; it opens the Add brush modal
(`BrushPickerOpenButton`, `controls/brush-picker.tsx:191`). So the button lies
about what it does, and the list has to carry the absence of a preset as if it
were one.

**The fix keeps a single entry point** (D12):

- The button becomes **Add brush**, which is what the modal it opens is already
  titled.
- Inside the modal, the first option is **New** — creates an empty brush — set
  apart from the list rather than sitting in it.
- `Init` comes out of `factoryPresets`, leaving **27**.

Knock-on edits: tour step 9 says "28 factory brushes" — becomes 27. The capture
script drives the `New brush` label in two places, once to open the picker for
its `modal-brush-picker` target (`capture-ui.mjs:74`) and once during setup to
load the demo brush (`capture-ui.mjs:262`); both need the new label. Any user
preset saved from Init keeps working — this changes the factory list and the
button, not the brush format.

#### WebP conversion

**Do this before the manual embeds any of them.** Nothing in `docs/manual.md` or
`README.md` references `docs/images/ui/` yet, so the format switch is currently a
change to one script plus a `git rm`. Once the manual carries twenty `![…](…png)`
links, it is that plus twenty edits and a stale-link risk. This is the cheapest
it will ever be.

**Playwright cannot do it directly** — `page.screenshot()` only encodes PNG and
JPEG, so this is a conversion step after the existing capture, not a parameter
change. Options, in preference order:

1. **`sharp` as a devDependency** — prebuilt binaries on every platform we build
   on, one `.webp({ quality, effort })` call per capture, no shell-out. The cost
   is a real dependency for a docs script.
2. **`cwebp` shelled out** — zero dependency, but it is a Homebrew/apt install the
   script can't assume, so it needs an "is it on PATH" guard and a clear failure
   message rather than a silent PNG fallback.
3. **`sips` on macOS** — already present, but macOS-only, which makes the docs
   build unreproducible anywhere else.

Lean: **sharp**, guarded so a missing binary fails the run loudly.

**Lossless or lossy** is worth deciding on the actual images rather than by
default. These are flat-UI screenshots — large areas of solid Mantine dark, hard
text edges, a few gradient spectrogram crops. Lossless WebP typically wins big on
that content and keeps text crisp; lossy at q80–90 wins bigger but can ring
around 1 px text. Suggest lossless for the UI-chrome targets and lossy for the
spectrogram-bearing ones (`window`, `file-lane`), decided by looking at the two
outputs side by side at 100%.

**Also switch `images/screenshot.jpeg`** (the README hero, in the repo-root
`images/` rather than `docs/images/`) if the same conversion path covers it, so
the repo has one image format rather than three — and consider collapsing the two
image directories while touching both.

### Phase 2 — Area registry

Grow `ui-anchors.ts` into the registry described in §3. No user-visible change;
this is the refactor everything else sits on.

1. Registry entry type: `anchor`, `title`, `blurb`, `manualSection`, optional
   `deepTour`, optional `recipes`.
2. Model **techniques** alongside areas — they carry a demonstration anchor rather
   than owning one.
3. Migrate `walkthrough.ts` and `capture-ui.mjs` to read from the registry rather
   than from the bare name tuple.
4. **The drift check** — a test asserting every registry entry has a matching
   heading in `docs/manual.md` and a screenshot in `docs/images/ui/`, and that no
   manual section is missing from the registry.

**Done when:** the drift check runs in `npm run test:run` and fails if you rename
a manual heading. This is the highest-value item in the whole plan — it turns "the
manual is out of date" from something you notice into something CI reports.

### Phase 3 — In-app copy: tooltips, effect descriptions, manual deep links _(unblocked)_

Three related problems in one pass, because they are all the same failure: copy
written from the code outward rather than from the reader inward.

#### 3a. Parameter tooltips are inconsistent in voice

122 `description:` entries in `parameters.ts`, 115 of them paired with a label.
Punctuation and length are already fine — every one ends in a full stop, none
exceeds 120 characters. **Voice is the problem**, and there are five competing
openings:

| Opening                             | Count |
| ----------------------------------- | ----- |
| "The …" (noun phrase)               | 30    |
| "How …"                             | 8     |
| verb-first ("Pans …", "Averages …") | 9     |
| "Controls …"                        | 6     |
| "Whether …"                         | 2     |

Worse, **32 of 115 restate their own label** and carry no information:

```
Mode      → "The mode of the modulator."
Depth     → "The depth of the modulator."
Rotation  → "The rotation of the modulator pattern."
```

A tooltip that repeats the label costs a hover and returns nothing. The good ones
already show what the target looks like — _"Averages the envelope signal over this
window of time to reduce fast transients"_ says both what it does and what it is
for.

**Proposed rule:** verb-first, present tense, name the audible result. Never open
with "The", "Controls", or the label itself. One sentence; a second only for a
non-obvious unit or interaction.

**A second vocabulary exists.** `CONTEXTUAL_MOD_SOURCES` in `constants.ts:206`
uses a different style entirely — no trailing full stop, parenthetical ranges
(`"Iteration index (0-1 across brush iterations)"`). Either bring it into the same
voice, or decide deliberately that range-first is right for modulation sources and
write that down.

#### 3b. Effect descriptions name the mechanism, not the result

13 entries in `EFFECT_DESCRIPTIONS` (`constants.ts:265`), shown in the Add Effect
picker and on effect cards — read at the moment of choosing, by someone who does
not yet know what the effect is. The long ones describe the algorithm:

```
Sort       → "Odd-even transposition sort on spectrogram bins by magnitude or phase."
Evolve     → "Reaction-advection-diffusion simulation for fluid, biological, and chaotic patterns."
Transmute  → 140 chars listing six polar operations
Waveshape  → 130 chars listing four shapes and four boundary modes
```

Against Overtones — _"Add overtones to create richer timbres"_ — which lands the
outcome in six words.

**Proposed rule:** one line, verb-first, ≤ 80 characters, naming the sound rather
than the maths. Enumerating modes is the effect card's job, not the picker's, and
the mechanism belongs in the manual, which already has a section per effect.

#### 3c. A help affordance that opens the manual at the right place

Two things block this today:

- **There is no manual link anywhere in the app.** The Help menu
  (`menu.ts:220`) holds only Run Walkthrough, plus Check for Updates off macOS.
  That link has to exist before anything can deep-link into it.
- **A Mantine tooltip cannot hold a clickable link.** The shared `Tooltip`
  (`components/tooltip.tsx`) is hover-only with `openDelay={1000}` and
  `maw={300}`; moving the pointer toward a link inside it dismisses it. So the
  affordance belongs on the **parameter label menu** (`controls/param-menu.tsx`,
  which already renders the description as its tooltip at line 140) — it is
  already clickable and already carries reset and randomise, the two other things
  a user discovers in that menu.

**Deep-link targets come free from Phase 2.** The registry already carries
`manualSection` per area; parameters gain an optional `manualSection` that
defaults to the containing area's, so most rows need no new copy at all.

**The manual is bundled, not linked out** (D11). `docs/manual.md` ships with the
build and renders in an in-app window, so help works offline and always describes
_this_ binary rather than whatever is on the default branch. What that buys and
costs:

- The markdown needs to reach the package — an `extraResources` entry, the same
  mechanism that the HRTF data needed and was once missing (a shipped-resource
  bug this repo has already had once).
- Rendering needs a markdown path in the renderer. Check whether one already
  exists before adding a dependency; if not, the manual's own subset — headings,
  lists, tables, inline code, links — is small enough to be worth measuring
  against pulling in a parser.
- Anchor resolution becomes ours rather than GitHub's. The viewer must derive
  heading ids by the same slug rule the drift check asserts against, or
  `manualSection` values will resolve in CI and fail in the app.
- External links inside the manual still need `shell.openExternal` rather than
  navigating the window.

**Done when:** no description restates its label; every parameter description
passes a lint rule for the voice rule above; all 13 effect descriptions are ≤ 80
characters and name a result; Help → Manual opens; and per-parameter deep links
resolve to real headings — extend the Phase 2 drift check to assert that every
`manualSection` referenced by a parameter or an area matches a heading in
`docs/manual.md`.

### Phase 4 — Discoverability overlay + deep tours _(unblocked)_

**The idea:** a Help affordance that outlines every interactive area at once.
Clicking one opens that area's deeper material.

**Trigger: both** (D3) — a `?` button and the `?` key. The button's home is an
implementation call; the transport is the obvious candidate since it is the one
bar that is always visible regardless of what is open, and it already holds
global rather than per-brush controls.

**The overlay is bespoke.** driver.js highlights one element at a time; "show
everything at once" is a portal with an absolutely-positioned outline per
`[data-anchor]` from `getBoundingClientRect()`, each clickable — roughly 100 lines,
no new dependency. driver.js still drives what happens after the click.

**Each outlined area offers two things, not one:** its deep tour, and the recipes
tagged to it. That makes the overlay the single place where "what is this?" and
"what do I do with it?" both start, and it is why the registry entry carries
`recipes` alongside `deepTour` (§3). It also gives Phase 5 somewhere to surface
from other than a README link.

**Deep tours do not gate** (D4). Each one runs straight through the important
parts of its area — no do-the-thing-to-advance. The first-run gates exist because
a brand-new user needs to build something with their own hands; someone who has
opened the overlay is looking something up and should not be made to perform.
Cheaper to write, cheaper to maintain, and it means a deep tour can cover a
control that is not currently actionable.

**Scope discipline: do not write 14 deep tours.** Three or four for the genuinely
non-obvious areas — Modulation, Steps, Source / clone-stamp, History — and let the
overlay blurb plus a manual link cover the rest. Deep tours teach _undiscoverable
interactions_ (double-click to reset, shift-drag snapping, the randomise menu,
brush hotkeys, right-click Link for latency), not what sliders do. Every parameter
already has a tooltip and the manual covers the rest.

**Done when:** the overlay opens from both the `?` button and the `?` key; every
outlined area offers a deep tour or a manual deep link, plus any recipes tagged to
it; and no deep tour restates a tooltip.

### Phase 5 — Recipes _(blocked only on running them)_

**`docs/recipes.md`**, separate from the manual: the manual is already 587 lines,
recipes grow forever, and they are read in a different mode. Linked from the README
alongside the manual, and surfaced per-area from the overlay (Phase 4).

**Both angles** (D6) — some DAW-familiar moves as the on-ramp for people arriving
from Ableton, and some that nothing else can do. The starter list below already
splits roughly that way: _Rhythm_ and _Pitch and time_ are mostly the first kind,
_Space and texture_ and _Repair_ mostly the second. Worth keeping the ratio
deliberate rather than letting the easy-to-write ones crowd out the strange ones,
since the strange ones are the argument for the app.

**Format per recipe:** Goal (one line) → Set up (the settings that matter) → Do
(the gesture) → Variations → _See also_ links into the manual.

**Starter list**, inferred from the parameter definitions and factory presets —
**none of this ships until it has been run and listened to**:

- _Rhythm_ — Chop to the hits (grid = **Onsets**, Anchor = Corner, Size ↔ = Grid;
  the best answer to "chop up a beat", enabled by the onset work) · Rearrange beats
  (Shift+click Source on beat 3, Tracking = Fixed, paint on beat 1) · Erase a hit
  (Eraser, Size ↔ = Grid, snap on) · Turn a pad into a rhythm (Dynamics gate driven
  by a Sequencer modulator — the Step Gate preset taken apart)
- _Pitch and time_ — Pitch up/down (Transform Shift ↕, **and choose the warp
  algorithm**: Percussive for drums, Neutral for sustained — worth a recipe purely
  to teach that choice) · Reverse (Scale ↔ = −1) · Half-speed (Double Length, then
  Scale ↔ = 2) · Harmonise (Clone Space ↕ = 7 st, or Overtones with Shape =
  Selected Scale)
- _Space and texture_ — Reverb from nothing (Blur, Origin = Left) · Reverse reverb
  (Convolve with the bundled IR, Rate = −1) · Freeze/smear (Blur ↔ 100%, wide
  Size ↔) · Build a hat from noise (Synthesize = Impulse, tight envelope, Align)
- _Repair_ — Undo locally (Restore brush, Read From = Original, painted over the
  region you regret — surgical undo without touching history) · Mute a vocal (AI
  split, erase on the vocal stem, merge the group back)

**Two connections worth building for:** a recipe and a deep tour are the same
content in two renderings, so a recipe should be a structured object rather than
free prose. And recipes want _before/after_ spectrogram pairs — the capture
harness already paints strokes via Playwright, so those can be generated rather
than hand-cropped.

**The cost, stated plainly:** recipes rot silently in a way reference doesn't. A
parameter rename breaks the manual visibly, but a recipe can keep reading fine
while no longer working. Each recipe's setup should be concrete enough for the
Playwright harness to execute and assert the output isn't silent or unchanged.

---

## 6. Decisions

Ten of eleven are settled. **D5 is the only one still open.**

| #   | Decision                                                | Resolution                                                                                                                                                                                 |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Multi-file tour                                         | **Always open the demo file** and scroll to it. If it is already open, just scroll to it. The tour never runs on whatever the user happened to have loaded.                                |
| D2  | Transmute / Waveshape                                   | **Stay hidden; remove them from the README.** Effect count drops to 11. They keep working in brushes that already use them, and the manual keeps documenting them.                         |
| D3  | Overlay trigger                                         | **Both** — a `?` button _and_ the `?` key. Button placement is an implementation call.                                                                                                     |
| D4  | Deep tours                                              | **No gating.** Each one runs straight through the important parts of its area. Cheaper to write and cheaper to maintain than the first-run gates.                                          |
| D5  | Tour copy — registry-authored or manual-derived?        | **Still open.** Lean unchanged: separate but linked, with the drift check as the safety net.                                                                                               |
| D6  | Recipes angle                                           | **Both.** Some DAW-familiar moves as the on-ramp, and some genuinely weird ones that nothing else does.                                                                                    |
| D7  | Onset features                                          | **Document them now** — the onset engine is settled.                                                                                                                                       |
| D8  | Version bump                                            | **Not yet.** `package.json` stays at `0.1.17` for now.                                                                                                                                     |
| D9  | Punchy                                                  | **Moot — committed, then removed.** See the note below.                                                                                                                                    |
| D10 | Demo file                                               | **Keep `bundled://pad-loop.mp3`.** A better loop lands later; it is a one-line swap when it does.                                                                                          |
| D11 | Manual location for in-app links                        | **Bundle it.** The manual ships with the build and renders in-app — offline, and versioned with the binary rather than pinned to a branch.                                                 |
| D12 | Preset entry point, once New brush makes an empty brush | **Keep one entry point.** The button becomes **Add brush**, matching the modal it already opens. Inside, the first option is **New** — creates an empty brush — with the presets below it. |

**On D9.** The plan previously recorded Punchy as uncommitted working-tree work
that the manual documented. Both halves were stale. `93510c5 ♻️ (transform): fold
Punchy and the plain rule into one Neutral algorithm` committed it and then
dissolved it — `Punchy` appears nowhere in `src/` today. The manual is already
correct, documenting the current set: Neutral (default, re-anchors transients at
detected onsets), Neutralish, Percussive, Flangey, Noisey. Nothing to do.

---

## 7. Risks

- **Phase 0 is a large uncommitted change sitting in a working tree that also holds
  unrelated in-progress work** (image export, boundary conditioning, onsets). The
  longer it sits, the more expensive the eventual commit split.
- **The drift check is the only thing that makes this maintainable.** Without
  Phase 2, every subsequent phase adds another place the UI is described, and the
  documentation debt compounds rather than being caught.
- **Recipes rot silently** — see the cost note in Phase 5.
- **In-app copy has no test today.** 122 parameter descriptions and 13 effect
  descriptions can drift back out of voice one PR at a time unless the Phase 3
  lint rule lands with the rewrite rather than after it.
