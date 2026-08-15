# Noise Canvas Manual

The complete guide to Noise Canvas. For downloads, installation, and build instructions, see the [README](../README.md).

Every control in the app has a tooltip and an entry in the `?` overlay, and how to use a tool should be mostly obvious just by using it. This manual is for when it isn't.

## Contents

1. [Core Concepts](#core-concepts)
2. [The Interface](#the-interface)
3. [Brushes](#brushes)
   - [The Palette](#the-palette)
   - [The Brush List](#the-brush-list)
   - [Steps](#steps)
   - [Macros](#macros)
   - [Source](#source)
   - [Envelope](#envelope)
   - [Options](#options)
   - [Warp Algorithms](#warp-algorithms)
   - [Blend Modes](#blend-modes)
4. [Effects](#effects)
   - [Dynamics](#dynamics) · [Transform](#transform) · [Blur](#blur) · [Repeat](#repeat) · [Synthesize](#synthesize) · [Evolve](#evolve) · [Binaural](#binaural) · [Sort](#sort) · [Transmute](#transmute) · [Waveshape](#waveshape) · [Convolve](#convolve) · [Align](#align) · [Attract](#attract)
5. [Modulation](#modulation)
   - [How Modulation Amount Works](#how-modulation-amount-works)
   - [Modulator Modes](#modulator-modes)
   - [Pattern Shapes and Images](#pattern-shapes-and-images)
   - [Modulator Controls](#modulator-controls)
   - [The Sequencer Grid](#the-sequencer-grid)
   - [Contextual Sources](#contextual-sources)
   - [Nested Modulation](#nested-modulation)
6. [Fill Grid](#fill-grid)
7. [Parameter Controls](#parameter-controls)
   - [Section Presets](#section-presets)
   - [Randomization](#randomization)
   - [Linking Parameters Across Steps](#linking-parameters-across-steps)
8. [Working with Files](#working-with-files)
   - [Splitting a File](#splitting-a-file)
   - [Stem Groups](#stem-groups)
   - [Onsets](#onsets)
   - [The Level Strip](#the-level-strip)
   - [Navigating the Canvas](#navigating-the-canvas)
9. [History](#history)
10. [Transport and Output](#transport-and-output)
11. [Menus](#menus)
12. [Keyboard Shortcuts](#keyboard-shortcuts)
13. [Getting Help](#getting-help)
14. [Where Things Are Saved](#where-things-are-saved)
15. [Working with Ableton Live](#working-with-ableton-live)

---

## Core Concepts

At its heart, Noise Canvas is about **painting sound directly into a spectrogram**.

A spectrogram is a visual representation of sound where:

- The **horizontal axis** is **time** (measured in beats)
- The **vertical axis** is **pitch** (measured in semitones)
- The **brightness or color** represents **amplitude**

When you load an audio file, Noise Canvas analyses it into this form using the **Constant-Q Transform (CQT)**, which gives a musically intuitive frequency layout.
Instead of abstract FFT bins, you're working in **beats and notes**. That means everything you draw, erase, blur, shift, or distort corresponds directly to musical structure.

The app stores **complex** coefficients (magnitude _and_ phase), not just a picture. Effects operate on both, which is why transients survive being moved around, why stereo and binaural work at all, and why the results resynthesise back to real audio rather than a vocoder-y approximation.

The workflow is simple:

1. Load a sound.
2. Build a brush out of one or more effects.
3. Paint across time and pitch.
4. Hear the results instantly.

This approach makes sound design tangible, almost physical. You're literally **painting timbre**.

You can load **multiple audio files** at once and choose which one acts as the source (where data is pulled from) and which as the target (where data is painted to). A branching history and versioned saving let you experiment freely without fear of breaking anything.

### Why Constant-Q

The Constant-Q Transform adjusts time resolution based on frequency:

- Low frequencies → lower time resolution (smeared in time, accurate in pitch)
- High frequencies → higher time resolution (precise in time, less in pitch)

This matches human hearing and avoids the artificial "FFT sound," producing more natural transients and harmonics.

### Analysis Resolution

Where a file sits on that trade-off is set when it is analysed, and shown as a badge in its header. The badge is a menu: pick a resolution from it and the file is analysed again at once, which adds a node to its history rather than replacing anything. The setting is bands per octave: more bands separate pitches more finely, and each band then needs a longer window to do it, which smears events in time.

| Badge            | Bands/octave | What it does                                                                                 |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------- |
| **Best Time**    | 12           | Sharpest transients, coarsest pitch. Drums, percussive edits, anything where attacks matter. |
| **Better Time**  | 24           | Leans toward time, still separates notes usefully.                                           |
| **Balanced**     | 36           | The default. Handles pitched material and transients without favouring either.               |
| **Better Pitch** | 48           | Leans toward pitch, at some cost to attacks.                                                 |
| **Best Pitch**   | 60           | Finest pitch separation, softest transients. Pads, drones, harmonic work.                    |

The choice affects what edits sound like, not just how the spectrogram looks: a shift or stretch is reconstructed from these bands, so a file analysed at 12 bands per octave keeps its clicks crisp while one at 60 keeps its harmonics clean.

Files run to a little over five minutes at 44.1 kHz, and less at higher sample rates or with several files already open.

---

## The Interface

![The Noise Canvas window](images/ui/window.webp)

The window is split into three columns, with a menu bar above and a transport bar below:

- **Top: Menu bar.** File, Edit, View and Help, with the memory reading and the **?** button at the right-hand end.
- **Left: Brush panel.** Everything that defines the current brush: Macros, Steps, Source, Envelope, Options, Effects, Modulators.
- **Middle: Canvas.** Every open file stacked vertically, each with its own header, time legend, and pitch legend. Minimized files collapse into the dock at the bottom.
- **Right: Sidebar.** The open palettes and their brushes on top, the history tree below.
- **Bottom: Transport.** Playback, grid, scale, meters, stroke limiting, Ableton Link.

**Compact UI** (`Cmd/Ctrl+Shift+C`, or **View → Compact UI**) shrinks every control so more fits on smaller screens.

---

## Brushes

Everything in Noise Canvas revolves around the brush. It's the link between what you see and what you hear.

When you paint, the brush defines **where** and **how strongly** an effect is applied to the spectrogram. Effects are modular: you can enable several at once, tweak them independently, and reorder them to change their processing order.

### The Palette

![The palette section of the sidebar](images/ui/section-palette.webp)

A palette is a folder of brushes for one job. The sidebar shows each open palette as a grey band with its brushes indented under it, and you can have as many open at once as you like.

- **Click a band** to fold its brushes away. **Double-click** the name to rename.
- **Drag** a brush from one palette to another to move it between them.
- The band's **⋮** offers Save, Save as…, Rename, Close and Delete file….
- **Add palette** at the bottom of the sidebar opens the browser: **New** for an empty palette, or any saved one below it.

![The Add palette browser](images/ui/modal-palette-picker.webp)

- **Add brush** sits at the end of each palette's own list, so a new brush always lands where you asked for it.
- A band shows its name in _italics_ once its brushes drift from the saved file. Closing a dirty palette asks first; its brushes close with it.
- The last open palette cannot be closed, so there is always somewhere for a new brush to go.

Palettes are JSON in `Documents/Noise Canvas/Palettes/`, beside the `Presets/` folder single brushes save to. Opening one always makes a fresh copy, so the same palette can be open twice and edits never reach back into the file until you Save. Seven ship with the app, one per job:

| Palette      | Brushes                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Restoration  | Eraser · Noise Gate · Restore · High-Pass · Compressor · Smudge                                   |
| Breaks       | Stamp · Jungle Stretch · Stutter · Rewind · Eraser · Reverse · Echo · Step Gate · Octave Down     |
| Vocals       | Eraser · Noise Gate · Magnet · Compressor · Harmonics · Shimmer · Reverb (Blur) · Stereo Widening |
| From Scratch | Paint Tone · Paint Noise · Stack · Crackle · Harmonics · Octave Up · Sampler · Convolution        |
| Mixing       | Booster · Compressor · Dynamic Bloom · Low-Pass Sweep · High-Pass · Stereo Widening               |
| Space        | Reverb (Blur) · Echo · Shimmer · Freeze · 3D Orbit · Stereo Widening                              |
| Mangle       | Pixel Sort · Crush · Updraft · Flow · Smudge · Reverse · Octave Down · Morph (Macros)             |

A brush can sit in several palettes. The picker shows which ones under each brush's name.

### The Brush List

Brushes live inside a palette. You can have as many open as you like; each is an independent set of steps, effects, modulators, and macros. **Add brush** puts a new one in the palette holding the brush you have selected.

- A **colour bar** down the left edge identifies each brush; the same colour marks it wherever it is referenced.
- **Hover** a row to see what is in it: each step's effects, in order.
- **Click** a row to make it active. **Double-click** the name to rename.
- The **⋮ menu** offers Rename, Duplicate, Save, Save as…, Load referenced files, Assign key…, Remove key, and Close.
- **Drag** rows to reorder them, or to move a brush into another palette.
- **Add brush** at the end of each palette opens the picker: **New** for an empty brush, or any preset below it.

![The Add brush picker](images/ui/modal-brush-picker.webp)

**Hotkeys.** Any brush can be bound to a letter key (⋮ → _Assign key…_, then press a letter). Pressing that letter anywhere in the app jumps straight to that brush. The number keys **1–9 and 0** always select the first ten brushes in the sidebar, counting across every open palette in order.

**The library.** Brushes are saved as JSON presets in `Documents/Noise Canvas/Presets/`. A brush loaded from the library remembers where it came from: _Save_ overwrites it, _Save as…_ creates a new one. A dirty marker appears when the brush has drifted from its saved version. This is the level below the palette, one brush to a file, where a palette is a whole set.

### Steps

![The Steps strip](images/ui/section-steps.webp)

A brush can have up to **5 steps**, shown as a tab strip. Each step is a complete, independent set of brush parameters and effects, and a single stroke runs through **all** of them in order. This is how you build multi-stage moves: step 1 synthesizes a tone, step 2 blurs it, step 3 spatializes it.

- **Drag** to reorder, **Duplicate** and **Delete** from the buttons on the right.
- The strip is fixed-width, so adding or removing a step never rescales the others.

### Macros

![The Macros section](images/ui/section-macros.webp)

Four renamable **Macros** per brush. A macro is just a knob that can modulate any modulatable parameter, at any depth, positive or negative. Good for collapsing a complicated brush down to one or two performance controls. Rename them from the parameter label menu (pencil icon).

### Source

![The Source section](images/ui/section-source.webp)

By default a brush reads from the file it's painting on. The **Source** section changes that:

- **Source** – hold **Shift** (or click the Source control to arm it) and click on any open file's canvas to pick a source file and position. A brush-sized rectangle previews where you're sampling from.
- **Tracking** – how the source position is used:
  - **Follow** – the source moves along with your stroke.
  - **Fixed** – always samples from that exact position.
  - **Anchored** – keeps a fixed offset relative to where the stroke started, like the clone stamp tool in Photoshop.
- **Time ↔ / Pitch ↕** – explicit source position, as a percentage of the source file (disabled in Follow mode, and both are modulatable).
- **Read From** – **Current** paints using the source file's edited state, **Original** paints from its unedited analysis. This is how the "Restore" brush works.

### Envelope

![The Envelope section](images/ui/section-envelope.webp)

The brush envelope decides where the stroke deposits energy and how much.

- **Strength** – how strongly the effect applies.
- **Anchor** – where the cursor sits on the brush. **Corner** puts the cursor at the onset (bottom-left) corner, so snapping locks onsets to the beat grid. Best for rhythmic strokes. **Center** puts the cursor at the brush centre, so snapping puts the envelope peak on the grid. Best for soft or ambient strokes.
- **Size ↔ (beats) / Size ↕ (semitones)** – brush size. At the minimum ("Grid") the brush tracks the current grid spacing; at the maximum ("Full") it fills the whole file in that axis and anchors to the edge.
- **Curve ↔ / ↕** – shape of the envelope in each axis: −100% is a sharp spike, 0% a linear triangle, +100% a hard rectangle. Lower the curve for softer edges.
- **Skew ↔ / ↕** – where the envelope peak sits. For time, −100% is an early pluck, 0% centred, +100% a delayed hit; for pitch, −100% bottom, +100% top.

### Options

![The Options section](images/ui/section-options.webp)

- **Blend mode** – how the processed and original spectrogram are combined (see below).
- **Pan** – stereo positioning of the processing.
- **Iterations** – how many times the effect chain recursively re-applies within one stroke (feedback, echoes, spectral delays).
- **Wrap** – behaviour when painting off the canvas edges: Off, Time, Pitch, or Time & Pitch.
- **Warp algo** – resynthesis strategy (see below).
- **Accumulate** – when on, painting over the same area builds up; when off, a single stroke won't overlap itself, so dragging back and forth doesn't double-apply.

### Warp Algorithms

Moving sound in time or pitch means rebuilding it, and each option colours the result differently. Pick by ear:

| Algorithm      | Sounds like                                                | Reach for it on                                          |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| **Neutral**    | Clean and faithful. Attacks stay sharp, notes stay steady. | Anything. Start here and only change if you want colour. |
| **Neutralish** | Neutral with a slightly softer edge.                       | Sustained material that Neutral makes sound too tight.   |
| **Percussive** | Hard and snappy, attacks pushed forward.                   | Drums, and anything that needs to snap.                  |
| **Flangey**    | Hollow and metallic, like a comb filter.                   | Adding a phasey, robotic character on purpose.           |
| **Noisey**     | Diffuse and breathy, edges blurred away.                   | Pads, textures, and turning a sound into a wash.         |

### Blend Modes

How the processed data merges with the original spectrogram:

- **Mix** – normal crossfade.
- **Add** – adds the processed signal.
- **Subtract** – removes the processed values.
- **Multiply / Divide** – scale relationships.
- **Maximum / Minimum** – keep stronger or weaker values.
- **Difference** – absolute difference between source and result.
- **Dissolve** – noisy probabilistic mixing, like Photoshop's dissolve.
- **Mask** – a self-normalizing relative-energy gate: the original is kept only where the processed result also has energy.
- **Screen** – Photoshop-style brightening (inverse multiply).

---

## Effects

![The Effects section](images/ui/section-effects.webp)

Add effects with **Add effect** at the bottom of the Effects section. The picker lays them out in two columns with a description for each. A step holds **up to 10 effects**, and you can add several instances of the same effect, each with its own independent settings.

![The Add effect picker](images/ui/modal-add-effect.webp)

Each effect header has a **checkbox** that bypasses it, a **title that doubles as the drag handle** for reordering, and a **⋮ menu** with Duplicate, Reset to defaults, and Remove.

Several effects share an **Edge Mode**, which decides what happens to content that spills past the brush border:

- **Cut** – discard it.
- **Bleed** – pull in the surrounding content.
- **Wrap** – bring it back round the other side.
- **Clamp** – hold the value at the edge.
- **Reflect** – flip it back in, like a ping-pong.
- **Invert** – flip it back in upside down.

### Dynamics

![The Dynamics effect card](images/ui/effect-dynamics.webp)

Squashes, gates, expands or inverts whatever the brush covers. It works on each band separately rather than on the sound as a whole, so it can pull the hiss out from between notes and leave the notes alone.

- **Threshold** – amplitude threshold in dB.
- **Upper** – what happens above the threshold:
  - **1×** – leave it alone.
  - **0.5×** – compress it.
  - **2×** – expand it.
  - **0×** – gate it out.
  - **−1×** – invert it.
- **Lower** – the same, applied below the threshold.
- **Knee** – width of the transition zone around the threshold, in dB.
- **Gain** – overall output gain in dB.

**Try it for**

- Cleaning up a noisy recording. **Upper** at 1 and **Lower** at 0 silences everything under the threshold and leaves the rest untouched.
- Evening out a performance. **Upper** around 0.5 holds the loud moments down.
- Turning a sound inside out. **Upper** at −1 keeps what was quiet and drops what was loud.

### Transform

![The Transform effect card](images/ui/effect-transform.webp)

Moves sound through time and pitch: shift it, stretch it, mirror it, spin it. How it sounds afterwards depends a lot on the [warp algorithm](#warp-algorithms) in Options.

- **Shift ↔ / ↕** – move content in time (beats) or pitch (semitones).
- **Scale ↔ / ↕** – stretch or compress in time or pitch. Negative values reverse/mirror.
- **Rotation** – rotate the painted region, in degrees.
- **Edge** – behaviour at the brush borders.

**Try it for**

- Dropping a part an octave. **Shift ↕** to −12, with Percussive warp on drums and Neutral on anything sustained.
- Reversing a hit where it sits. **Scale ↔** to −1.
- Half-speed tape. Double the file's length first, then **Scale ↔** to 2.

### Blur

![The Blur effect card](images/ui/effect-blur.webp)

Smooths and blends over time and pitch: echo, reverb, and diffusion-like effects.

- **Blur ↔ / ↕** – degree of blur in time / pitch.
- **Noise ↔ / ↕** – random scattering to make the blur more diffuse.
- **Samples ↔ / ↕** – blur kernel sample count (quality vs. speed).
- **Edge** – behaviour at the brush border.
- **Origin** – where the blur radiates from:
  - **Left** – forwards, like reverb.
  - **Middle** – evenly, in both directions.
  - **Right** – backwards, like reverse reverb.

**Try it for**

- Reverb on something that never had any. Raise **Blur ↔** and set **Origin** to Left.
- Reverse reverb before a hit. The same, with **Origin** on Right.
- Freezing a sound into a pad. A wide brush with **Blur ↔** high smears everything under it into one sustained wash.

### Repeat

![The Repeat effect card](images/ui/effect-clone.webp)

Stamps beat- and semitone-spaced copies of the painted region in 2D: echoes, spectral delays, stacked harmonics.

- **Gap ↔ / ↕** – spacing between copies in beats / semitones (can be negative). With any shape other than Even this is the gap to the _first_ copy, and the shape sets the rest.
- **Copies ↔ / ↕** – how many copies each axis adds on top of the original (0–63). 0 leaves that axis alone.
- **Shape ↔ / ↕** – how the gaps grow from copy to copy. See the table below.
- **Dir. ↔ / ↕** – Forward/Middle/Backward and Up/Middle/Down.
- **Decay** – fade applied to each successive copy; the two axes multiply. 50% puts the outermost copy 30 dB down, 100% mutes every copy past the first.
- **Edge** – behaviour for copies extending past the border.

Overlapping copies add as waves, so a tight stack can interfere and comb. An axis set to 0 copies costs nothing: that pass is skipped entirely.

#### Shapes

Every shape places the first copy one **Gap** value out, so switching shape never moves it. Only the copies past it move.

| Shape ↕   | Shape ↔     | Gaps                                                                                           |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Even       | Even         | All the same. Gap ↕ = 12 gives octaves, 7 gives fifths.                                       |
| Harmonic   | Decelerating | The natural harmonic series. Gaps shrink as they climb.                                        |
| Geometric  | Accelerating | Every gap is twice the one before.                                                             |
| Inharmonic | Uneven       | The harmonic series stretched sharp, like a struck bar or a piano's top octaves.               |
| Scale      | n/a          | Even steps, with every copy snapped to the nearest note of the scale set in the transport bar. |

Even is the only shape with even gaps, and it is the only one a modulator can reach. Modulation stretches the whole comb at once, so it cannot make gaps unequal. That is what shapes are for.

Set **Copies ↔** to 0, **Shape ↕** to Harmonic and **Gap ↕** to 12 and Repeat stacks a harmonic series on whatever it covers. **Gap ↕** then doubles as the stretch: above 12 the partials spread sharp, below 12 they compress.

**Try it for**

- Echoes locked to the grid. **Gap ↔** to 1/2 b, **Copies ↔** to 4, and **Decay** to taste. 50% puts the last echo 30 dB down.
- Harmonies from a single note. **Gap ↕** to 7 st for fifths, 12 for octaves.
- Chords that stay in key. **Shape ↕** to Scale and **Gap ↕** to 3 or 4 for stacked thirds.
- Thickening a thin sound. A harmonic stack, as above, adds body without changing the pitch.

### Synthesize

![The Synthesize effect card](images/ui/effect-synthesize.webp)

Paints new sound from nothing, so you can draw parts that were never recorded.

- **Type** – Noise, Sine, or Impulse.

**Try it for**

- Drawing a hi-hat. **Impulse**, a short **Size ↔**, and a sharp **Curve ↔**.
- Adding air to a dull recording. **Noise**, painted gently over the top of the spectrum.
- Sketching a bassline. **Sine**, with pitch snapping on.

### Evolve

![The Evolve effect card](images/ui/effect-evolve.webp)

Lets the sound grow, flow and mutate on its own, into fluid, biological or chaotic textures. It is the least predictable effect here, and rewards small values.

- **Flow** – how strongly energy travels (negative reverses).
- **Spread** – positive spreads energy out, negative sharpens it.
- **Grow** – positive grows the sound, negative eats it away.
- **Swirl** – adds a rotation to the flow.
- **Drift ↔ / ↕** – pushes the movement in a direction in time / pitch.
- **Decay** – how fast it dies away (negative boosts instead).
- **Scale ↔ / ↕** – how far each step reaches, in time / pitch.
- **Edge** – behaviour at the brush border.

**Try it for**

- Turning a static pad into something that crawls. A little **Flow** and **Grow**, high **Iterations** in Options.
- Sharpening rather than smearing. **Spread** negative.
- Slow spectral decay. **Decay** up, everything else low.

### Binaural

![The Binaural effect card](images/ui/effect-binaural.webp)

Places the painted sound anywhere around the listener's head, in 3D. Made for headphones; on speakers you mostly hear it as width.

- **Azimuth** – horizontal angle (0° front, 90° right, −90° left, ±180° behind).
- **Distance** – source distance in metres (affects level and high-frequency absorption).
- **Stereo** – stereo spread around the azimuth (0° = mono, 180° = full L/R offset).

**Try it for**

- Putting a sound behind the listener. **Azimuth** to 180°.
- Pushing a part back without turning it down. Raise **Distance**.
- Orbiting a sound around the head. Modulate **Azimuth** with a slow pattern.

### Sort

![The Sort effect card](images/ui/effect-sort.webp)

Reorders the spectrogram's bins by how loud, high or wide they are. Pixel-sorting, for sound: glitched, banded and smeared.

- **Direction** – Horizontal, Vertical, or Both.
- **Order** – Forwards or Backwards.
- **Sort By** – Magnitude, Phase, dB, Frequency, or Pan.
- **Stereo** – sort channels Linked or Independent.

**Try it for**

- Glitchy vertical banding. **Direction** Vertical, **Sort By** Magnitude.
- Digital smear. **Direction** Both, over a busy passage.
- Stereo mess. **Stereo** to Independent so the channels drift apart.

### Transmute

Rewires magnitude against phase. Results run from metallic to completely unrecognisable, and it is worth auditioning rather than reasoning about.

- **Mode** – Swap Mag/Phase, Complex Power, Phase Rotate, Phase Quantize, Stereo Cross, or Phase Gate.
- **Amount** – the primary parameter for the selected mode.
- **Curve** – secondary shaping for the modes that use it.

### Waveshape

Distortion applied to the spectrum rather than to the waveform, so it adds grit and harmonics without the usual mush.

- **Shape** – Soft Clip, Hard Clip, Rectify, Fold, Wrap, or Sine.
- **Drive** – how hard it is pushed. For Fold, Wrap and Sine this sets how many times the sound folds back on itself.
- **Tilt** – biases the character of the distortion.

### Convolve

![The Convolve effect card](images/ui/effect-convolve.webp)

Prints the character of one sound onto another: reverbs, room tones, and stranger things when the impulse is not a room. Loudness is levelled automatically, so swapping impulses doesn't blow up the level.

- **IR** – the impulse-response file, chosen from your open files.
- **Taps** – number of IR frames applied (longer, more expensive tail).
- **Start** – where in the IR the first tap begins.
- **Pitch Shift** – pitch shift applied to the IR, in semitones.
- **Rate** – source read rate per tap (1 = forward, −1 = reverse; other values stretch or compress the tail).
- **Gain** – output gain of the convolution, in dB.
- **Edge** – behaviour for taps extending past the border.

**Try it for**

- A real room. Pick an impulse response and leave the rest alone.
- Reverse reverb. **Rate** to −1.
- Making one sound wear another. Load any recording as the IR — the odder the source, the odder the result.

### Align

![The Align effect card](images/ui/effect-align.webp)

No parameters. It lines up the start of the brush into a single sharp click, then lets the sound go back to normal.

**Try it for**

- Manufacturing a transient out of noise, so a formless sound gets an attack.
- Tightening an attack that has gone soft.

### Attract

![The Attract effect card](images/ui/effect-attract.webp)

Pulls energy across time and pitch toward a map: a landscape of valleys that sound falls into. The energy genuinely moves rather than being filtered away, so painting the same spot repeatedly gathers content into the valleys and settles it there.

- **Map** – what the landscape is made of:
  - **Source** – the sound's own loud content, so strong partials capture their neighbours.
  - **Scale** – a valley at every note of the global scale, so noise and smear take on a harmonic shape.
  - **Grid** – valleys on the snap grid's pitch and beat lines.
  - **Modulator 1–3** – a modulator's field, so energy gathers where the pattern is bright. An image modulator turns the picture into terrain the sound falls into.
- **Source** – picks the file whose loud regions form the Source map's landscape, matched by absolute frequency. Leave it empty and the sound attracts toward itself.
- **Pull ↔ / ↕** – how far energy moves along each axis. Negative pushes away; past 100 overshoots the target.
- **Smooth ↔ / ↕** – valley width per axis, in beats and semitones. Narrow valleys snap precisely and ignore distant content; wide valleys reach out and drag everything, and at the extreme the landscape flattens and the pull fades away.

**Try it for**

- Crystallising a noisy or smeared sound into the scale, so it turns harmonic. **Map** to Scale and **Pull ↕** up.
- Tightening loose timing. **Map** to Grid, with **Pull ↔** up and **Pull ↕** at 0.
- Making a sound collapse into its own strongest partials. **Map** to Source, painted repeatedly.

---

## Modulation

![The Modulators section](images/ui/section-modulators.webp)

Noise Canvas has a deep modulation system for automating parameters across time and pitch. Anywhere a parameter label opens a menu with a **Modulation** section, that parameter is modulatable. You get **three modulators** per step, plus four macros and eight contextual sources.

Modulation is evaluated **per pixel**, not per stroke. A modulator is a 2D field over the spectrogram, not an LFO on a timeline.

### How Modulation Amount Works

This isn't an "add some LFO on top" system. Think of it as **crossfading between the parameter's slider value and a fully modulated value that is always clamped to the parameter's legal range**.

- **Amount = 0%** → The parameter is **exactly** the value you set on its slider. No modulation is applied.
- **Amount = +100%** → The parameter ignores the slider and takes **pure modulation**, mapped from **that parameter's minimum up to its maximum**. It **never** goes out of range.
- **Amount = −100%** → Same as +100% but **inverted**: the modulator is mapped from **maximum down to minimum**.
- **Amounts in between** blend between the slider value and the modulated value.

The parameter menu shows the resulting **live range in real units** next to the Modulation header, so you can dial amounts in against concrete values rather than abstract percentages.

### Modulator Modes

- **Pattern** – a 2D shape scrolled across time and pitch.
- **Envelope** – follows the painted region's own **Amplitude**, **Phase**, or **Panning**, with adjustable smoothing window (in beats) and dB range.
- **Sequence** – a step grid you draw on: adjustable steps (1–16), rows (1–8), loop length in beats, pitch range in semitones, and swing.

### Pattern Shapes and Images

**Waveforms:** Sine, Triangle, Square, Sawtooth, Pulse, Random, Smooth Noise.

**Procedural textures:** Quilt, Clouds, Cells, Bubbles, Craters, Ripples, Scratches, Swirls, Paper, Marble, Weave, Terrain, Flow.

**Selected Scale** – snaps modulation to the scale set in the transport bar.

**Images** – a set of factory textures ships with the app, and you can drop your own images in:

```
Documents/Noise Canvas/Textures/
```

They appear in the shape picker under a "User" group.

### Modulator Controls

- **Depth** – modulation intensity (bipolar; negative inverts).
- **Rate ↔** – how many beats one cycle of the pattern spans. Bigger is slower. At 0 ("Off") the pattern stops varying along time.
- **Rate ↕** – how many semitones one cycle spans. At 0 ("Off") it stops varying along pitch.
- **Rotation** – rotates the pattern.
- **Stereo** – decorrelates the left/right channels by offsetting the sample position in time. Negative values swap channels.
- **Phase Mode** – whether the pattern is anchored to the **Canvas** (fixed in the file, so strokes reveal a stationary pattern) or to the **Brush** (travels with each stroke).
- **Phase ↔ / ↕** – offsets the pattern's start position in each axis.

### The Sequencer Grid

In Sequence mode the modulator reads a grid instead of a shape. Steps run left to right in time and bands run bottom to top in pitch, and every cell holds one value between 0 and 1: the modulator's output wherever that cell lands on the canvas. A full cell drives the parameter to the top of its modulated range, an empty one to the bottom.

| Gesture                 | What it does                      |
| ----------------------- | --------------------------------- |
| Click a step            | Switches it on or off             |
| Drag up or down on it   | Sets its value                    |
| Drag sideways           | Switches a run of steps on or off |
| Right-drag              | Switches steps off                |
| Hold Shift while moving | Fine-tunes the value              |

A step switched off keeps its value and shows it as a faint line, so switching it back on returns the level you left. **Randomise** fills every cell with a random value, **Fill** switches the whole grid on, and **Clear** switches it off without losing the values.

**Steps ↔** and **Rows ↕** set the size of the grid, **Loop ↔** and **Loop ↕** set how far it stretches before repeating, and **Swing** pushes odd-numbered steps later.

**Hints**

- Off is the bottom of the parameter's modulated range, not "no modulation." On Strength that is silence, but on a pitch parameter it is the lowest pitch.

### Contextual Sources

Beyond the three modulators and four macros, every modulatable parameter can also be driven by stroke properties:

**Iteration** (index across brush iterations) · **Time Pos.** (position across the file) · **Pitch Pos.** (position across the frequency range) · **Randomize** (a random value per stroke) · **Step** (index across steps) · **Pressure**, **Tilt X**, **Tilt Y** (pen tablet input).

### Nested Modulation

Modulator parameters are themselves modulatable. You can modulate modulator 2's rate with modulator 1, or drive a modulator's depth from a macro. One level of nesting is supported.

> Nested modulation is not available on Windows.

---

## Fill Grid

**Fill Grid** paints the current brush on every cell of the grid at once, instead of you dragging out each stroke by hand. The grid icon on a file's header runs it, as does **Edit → Fill Grid with Brush** (`Cmd/Ctrl+G`). The whole pass commits as one stroke, so one undo takes it back.

It has no settings of its own. The rhythm comes from the grid you already set in the transport, and the size and shape of each stroke comes from the brush. Change the grid and you change the pattern; change the brush and you change the sound.

**Hints**

- Set the time grid to **Onsets** and the fill lands on the file's own hits instead of a fixed division, so a loosely played part is followed rather than flattened. Set the pitch grid to **Scale** to put a stroke on every note of the scale.
- Turn **Snap Time** or **Snap Pitch** off and that axis stops being divided, so one stroke spans it. With both off, a single stroke covers the whole file, which is how you apply a brush to everything at once.
- Drag on the time legend to set a loop region and the fill covers only that span.
- Every stroke uses the same brush, so a bare fill repeats one sound. Modulation is what varies it: a Random pattern on **Strength** gives each stroke its own level, and a sequencer on it draws a rhythm outright.
- To layer, fill twice, changing the grid or the brush between passes.

## Parameter Controls

![A parameter's label menu](images/ui/menu-parameter.webp)

- **Drag** a value to change it. **Hold Ctrl while dragging** to snap to that parameter's preset values (musical beat divisions, semitone intervals, and so on). **Hold Shift while dragging** for fine control, three times slower than a plain drag.
- **Right-click** a value to pick from its list of preset values. A small chevron marks the values that have one.
- **Click** a value to type a number in.
- **Double-click the label** to reset a parameter to its default. This also clears every modulation amount on it.
- **Click the label** to open the parameter menu: modulation amounts, reset, exclude-from-randomization, step linking, and a **book icon** that opens this manual at the section explaining that parameter.

### Section Presets

The **⋮ menu** on an effect card or the modulator holds a list of presets for that section: starting points for the things it is usually asked to do. Pick one and the whole section changes to it. Hover a name to read what it does.

The **+** on the Presets heading keeps the section's current settings under a name of your own, and yours then appear in the same list. Every row has a **⋮** on hover: **Duplicate…** on any of them, plus **Rename…** and **Delete…** on your own. The ones that ship with the app cannot be renamed or deleted, so duplicating is how you start from one and make it yours. Modulator presets are not tied to the modulator you saved them from, so one saved on modulator 1 loads into any of the three.

Presets carry values only, so any modulation you have wired up survives loading one.

### Randomization

Every section header has a **⋮ menu** with a Randomize block:

- **Amount** – how far values are allowed to move, as a percentage of each parameter's range. Values never leave their legal range, even at the edges.
- **Include Mod.** – whether modulation amounts get randomized too.
- **Randomize** – do it.

The Effects section also shuffles effect order and enabled states. Individual parameters can be **excluded from randomization** from their label menu, so you can lock the bits you like and re-roll the rest.

### Linking Parameters Across Steps

From a parameter's label menu, toggle the **link** icon to link it across all of the brush's steps. Changing it in one step then changes it everywhere. Useful for keeping brush size or blend mode consistent across a multi-step brush.

---

## Working with Files

![A file's header](images/ui/file-header.webp)

Open a file from **File → Open**, from **Open Recent**, or by **dragging an audio file onto the window** (one at a time).

Open files stack vertically in the canvas column. Each header gives you:

- The **filename** (italic when it has unsaved changes) and a **resolution badge**.
- **BPM** – this file's tempo, which drives grid snapping and every beat-based parameter.
- **Onsets** – how sensitive the hit detector is for this file. See [Onsets](#onsets).
- **Split** – see below.
- **Duplicate** – an editable copy, with its own history.
- **Minimize** – collapse it into the dock at the bottom of the canvas area. A docked file stays open and can still be used as a source; click it to bring it back.
- **Fullscreen** – expand it to fill the canvas area.
- **Close**.

The active file has an orange border; click any file to make it active. `Tab` / `Shift+Tab` cycle through them.

Files you create in-app (New File, duplicates, stems) are **fully persisted**. They're backed by their own on-disk history, so quitting never loses them, and they get a real path when you Save As.

### Splitting a File

The split menu on each file header:

- **Split Harmonic and Percussive (HPSS)** – separates the file into harmonic and percussive layers.
- **Split into N Parts (NMF)…** – non-negative matrix factorization into any number of components.
- **Split Drums / Bass / Other / Vocals (AI)** – neural stem separation. Not available on Intel Macs, so the item is hidden there.

### Stem Groups

Every split produces a **stem group**: the parts stay ordinary files (every brush and effect works on them unchanged), but they're bracketed together in the UI, share a colour, and remember that their coefficients still sum back to the original.

- **Sync view** – zoom and scroll follow each other across all members.
- **Merge** – sums the group back into a new file, in the coefficient domain, so a split-then-merge round trip is lossless. The parts stay open.
- **Close group** – closes every member with one confirmation.

This is the resample loop: split, paint on one part, merge back.

### Onsets

Every file is scanned for **onsets**: the moments where a new sound starts. They're detected from the analysis itself, not from the tempo, so they follow what's actually in the audio however loosely it was played.

Onsets show up in three places:

- **The onset strip** – a thin row of markers directly above the spectrogram, one line per detected hit. Brighter lines are stronger onsets.
- **Onsets sensitivity** – the **Onsets** control in the file header. It sets how far down this file's own level range a hit still counts: **0%** keeps only the loudest, **100%** keeps everything the detector found. Because the range is per-file, the same percentage means something comparable on a quiet pad and a hot drum loop. It applies to that file's path, so it survives closing and reopening.
- **Onset snapping** – set the time grid (**Beats**) to **Onsets** in the transport bar. Strokes then snap to detected hits instead of beat divisions, so a stroke lands exactly on a transient rather than near it. Pair it with **Anchor = Corner** in [Options](#options) so the cursor is the stroke's own onset.

Onsets also drive the [warp algorithms](#warp-algorithms): **Neutral** re-anchors phase at each detected onset when it moves audio, which is what keeps a moved drum hit cracking instead of smearing into pre-echo. Lower the sensitivity if a busy file is being over-anchored; raise it if quiet hits are smearing.

Onsets are recomputed for the region around a stroke after you paint, so they track your edits rather than describing the file you loaded.

### The Level Strip

A thin strip sits directly above each file's spectrogram, showing how loud the finished audio is at every moment. It is always there and has nothing to set. Read it left to right like the file itself, and it tells you where you are running out of room.

- **Dark** – quiet, or nothing at all.
- **Light, up to white** – healthy level.
- **Yellow** – close to full scale. Still fine, but there is no headroom left to give.
- **Red** – out of headroom. The deeper the red, the further past it went.

Red means one of two things, depending on [Auto-limit](#transport-and-output). With it on, red marks the moments the limiter is holding down for you, so it is a report rather than a problem. With it off, red is real clipping in the output, and it is worth undoing the stroke or painting it more gently.

The strip describes the whole file's output, not just your last stroke, so a red patch somewhere you are not working is still worth looking at.

### Navigating the Canvas

![A file's canvas](images/ui/file-lane.webp)

Time axis, on the spectrogram itself:

- **Right-click drag** – pan, with momentum.
- **Pinch**, or **`Cmd`/`Ctrl` + scroll** – zoom in time, around the cursor.
- **Two-finger horizontal scroll** – pan.
- **Vertical scroll** – scrolls the file list rather than the file.

Pitch axis, on the **pitch legend** down the left edge:

- **Drag left/right** – zoom in pitch, around the point you grabbed.
- **Drag up/down** – scroll through the frequency range (once zoomed in).

When zoomed in far enough, the pitch legend turns into a piano keyboard so you can see where the notes are.

On the **time legend** along the bottom:

- **Click** – set the playback start position (snapped to the grid).
- **Drag** – set a loop region, which also moves the playback start to its beginning.

Zoom and scroll are remembered per file across restarts, and files in a [stem group](#stem-groups) with **Sync view** enabled share all four (time zoom, time scroll, pitch zoom, pitch scroll).

---

## History

![The History panel](images/ui/section-history.webp)

Every edit you make is captured in the **History** panel, but it's a **branching tree**, not a flat undo list. If you undo a few steps and then paint something new, the steps you undid aren't thrown away. They stay as a separate branch you can return to at any time. This lets you explore variations freely without ever painting yourself into a corner.

Each node is a snapshot of the file at that point. The **current** state is highlighted, and every node shows its label and how long ago it was made.

- **Jump to any state** – click a node to instantly return the file to it.
- **Undo / Redo** – the arrows at the top of the panel step to the parent node (undo) or the most recently visited child (redo). `Cmd/Ctrl+Z` and `Shift+Cmd/Ctrl+Z` do the same.
- **Rename** – double-click a node (or right-click → Rename).
- **Favorite** – right-click → Favorite to star the states you like.
- **Export branch…** – renders out the audio for that node's lineage, one numbered WAV per node from the root down. (In the Ableton extension there's also **Export branch to Live**.)
- **Delete branch** – removes a node and everything downstream of it.

The panel's **⋮ menu** adds **Export History…**, **Export Favorites…**, and **Purge History**, which shows how much disk the tree is using and clears it to reclaim space while leaving the current state untouched.

History lives on disk per file, so the whole tree survives quitting and reopening. It's only deleted when you explicitly close the file.

---

## Transport and Output

![The transport bar](images/ui/transport.webp)

The transport bar, left to right:

- **Link** – toggle **Ableton Link** to sync tempo and start/stop with other Link-enabled apps on the network. The tooltip shows the peer count; **right-click** the button for latency compensation.
- **Play / Stop** (`Space`), **Loop**, and **Auto-play stroke** (the brush icon). When active, each stroke automatically plays back the region you just painted.
- **Playback time**.
- **Beats / Snap** and **Semis / Snap** – grid spacing and snapping per axis. Set the semitone grid to **Scale** to snap to the selected scale instead of a fixed interval, and the beat grid to **Onsets** to snap to the file's detected hits instead of a division (see [Onsets](#onsets)).
- **Swing** – swing feel for the time grid. 0% is straight, ~67% is a triplet feel, 100% shifts odd grid lines by half a cell.
- **Tonic / Type** – the scale used for pitch snapping and for scale-based effects and modulation.
- **Output meter**.
- **Auto-limit** – on by default. Holds each stroke's own level down as you paint it, leaving the audio around it untouched. On audio that is already loud, the stroke is held to the level that was there. It is baked into the stroke, so undo removes it along with the paint, and turning it off only affects what you paint next. Turn it off to paint as loud as the effect makes it, at the risk of clipping the output. Either way, [the level strip](#the-level-strip) above each spectrogram shows where the headroom went: with Auto-limit on, red marks what it is holding down for you, and with it off, red is clipping.
- **Re-analyse** – redraws each stroke as the analysis of the audio it made, so the picture settles into what you will hear, even edits that only move phase. Off, the canvas keeps exactly what you painted; the sound is the same either way, and commits are faster. Like Auto-limit, it is read at the end of each stroke.
- **?** – outlines every area of the window at once. See [Getting Help](#getting-help).

Audio is resynthesised incrementally after every stroke, so what you hear is always the real thing, not a preview. Nothing protects the output as a whole, which is what [the level strip](#the-level-strip) is for.

---

## Menus

The menus live in the window rather than in the system menu bar, so they read the same on every platform and inside Ableton Live. The right-hand end of the bar holds two things: how much of the graphics memory budget the open files hold, and the **?** button that opens the overlay.

Memory climbs with the length and resolution of everything you have open, not with how much you paint. Past about 90% a new file may be refused, or analysed at a lower resolution — close a file to make room.

**File**

- **New** (`Cmd/Ctrl+N`) – create an empty file (sample rate, BPM, length in beats).
- **Open…** (`Cmd/Ctrl+O`) / **Open Recent** – load existing audio. The recent list holds 20 files and persists across sessions.
- **Save** (`Cmd/Ctrl+S`) – write back over the original. Saves are atomic, so a crash mid-write can't corrupt your file.
- **Save As…** (`Cmd/Ctrl+Shift+S`).
- **Save Version** (`Cmd/Ctrl+Alt+S`) – save a numbered copy alongside the original without overwriting it.
- **Close File** (`Cmd/Ctrl+W`).
- **Export Image…** – save the active file's spectrogram as a PNG, for artwork rather than for audio. A live preview shows what you will get.
  - **Colour** – Editor keeps the app's own look. Mono, Magma, Viridis and Ice restyle it, and Random rolls a new palette each time you pick it.
  - **Shape** – 1:1, 4:5, 3:2, 16:9, or 9:16 for a phone screen.
  - **Size** – 2K, 4K or 8K along the long edge.
  - **Poster** – adds the file's name as a caption underneath.
- **Export History…**.
- **Quit** – on macOS this lives in the **Noise Canvas** menu instead.

**Edit**

- **Undo / Redo** (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`).
- **Fill Grid with Brush** (`Cmd/Ctrl+G`) – see [Fill Grid](#fill-grid).
- **Restore Original** – reload the unedited file.
- **Duplicate File** (`Cmd/Ctrl+D`).
- **Double Length / Half Length** – stretch or shrink the file's length.

**View**

- **Compact UI** (`Cmd/Ctrl+Shift+C`).

**Help**

- **Manual** (`Cmd/Ctrl+/`) – open this document in a window inside the app.
- **Run Walkthrough** – replay the first-run tour at any time. See [Getting Help](#getting-help).
- **Check for Updates…** – see below.

Re-analysing a file is not in these menus. The resolution badge in each file's header does it, so it acts on the file you point at rather than on whichever one is active. See [Analysis Resolution](#analysis-resolution).

**Updates**

**Check for Updates…** sits under **Help**, and on macOS in the **Noise Canvas** menu as well. It tells you whether a newer version exists. Installing it is a manual job: download the new build from the [Releases page](https://github.com/robclouth/noise-canvas/releases) and replace your copy.

---

## Keyboard Shortcuts

File and Edit shortcuts (`Cmd/Ctrl+N`, `+O`, `+S`, `+W`, `+D`, …) are listed under [Menus](#menus).

| Key                   | Action                                                 |
| --------------------- | ------------------------------------------------------ |
| `Space`               | Play / stop                                            |
| `Arrow keys`          | Move the brush by one grid cell                        |
| `Enter`               | Apply the brush at the current position                |
| `-` / `=`             | Decrease / increase the time grid                      |
| `Shift` + `-` / `=`   | Decrease / increase the pitch grid                     |
| `Tab` / `Shift+Tab`   | Next / previous file                                   |
| `1`–`9`, `0`          | Select the first ten brushes                           |
| `a`–`z`               | Select the brush bound to that key                     |
| Hold `Shift` + click  | Pick a source file and position                        |
| `Cmd`/`Ctrl` + scroll | Zoom                                                   |
| Right-click drag      | Pan                                                    |
| `Cmd/Ctrl+Z`          | Undo                                                   |
| `Shift+Cmd/Ctrl+Z`    | Redo                                                   |
| `Cmd/Ctrl+Shift+C`    | Toggle compact UI                                      |
| `?`                   | Outline every area (see [Getting Help](#getting-help)) |
| `Cmd/Ctrl+/`          | Open this manual                                       |

---

## Getting Help

Six places, each answering a different question.

| Surface            | How you get there                                         | What it answers                     |
| ------------------ | --------------------------------------------------------- | ----------------------------------- |
| **Tooltip**        | Hover any control for a second                            | What does this one control do?      |
| **Parameter menu** | Click a parameter's label, then the book icon             | …and where is it explained in full? |
| **`?` overlay**    | The **?** button in the menu bar, or the `?` key          | What is all this?                   |
| **Deep tour**      | Click an area in the `?` overlay → **Show me around**     | How does this part work?            |
| **Walkthrough**    | Offered on first launch; **Help → Run Walkthrough** after | Where is everything?                |
| **This manual**    | **Help → Manual** (`Cmd/Ctrl+/`), or any book icon        | What does this do, exactly?         |

The `?` overlay dims the window and brightens whatever you point at, with a description beside it. It covers regions, parameters and every button and widget, down to individual controls, so pointing at something is the way to ask what it is. Each card offers that area's tour, if it has one, and the part of this manual that explains it. Menus and popovers are covered too: open one first, then press `?`, and the controls inside it answer like any other. Press `?` or `Esc` to close it.

Every tooltip and every overlay description comes from the same sentence, so the two can never tell you different things.

Deep tours don't ask you to do anything. They run straight through their area. The first-run walkthrough does, twice: it makes you add an effect and paint a stroke, so you finish it having built a working brush by hand.

The manual is bundled with the app, so it works offline and always describes the build you're running rather than whatever is on the default branch. It has a search box at the top that filters to matching sections.

Separately, [**Recipes**](./recipes.md) covers what to actually _do_ with all this: start-to-finish walkthroughs of specific moves. Those live online rather than in the build, because they grow between releases. The `?` overlay links to the ones relevant to whatever area you clicked.

Found a bug? Report it on the [issues page](https://github.com/robclouth/noise-canvas/issues).

---

## Where Things Are Saved

```
Documents/Noise Canvas/Presets/               brush presets (.json)
Documents/Noise Canvas/Presets/Effects/       your effect presets
Documents/Noise Canvas/Presets/Modulators/    your modulator presets
Documents/Noise Canvas/Textures/              your own modulator images
~/.noise-canvas/models/             downloaded AI separation models
<user data>/history/<fileId>/       per-file history trees
```

`<user data>` is Electron's per-app data directory: `~/Library/Application Support/…` on macOS, `%APPDATA%\…` on Windows, `~/.config/…` on Linux. History is the one that grows: each file's tree is stored there until you close the file or use **Purge History**, and the History panel's ⋮ menu shows the current size.

Your open files, their zoom and scroll positions, BPMs, brushes, and window settings are all persisted too, so the app reopens where you left it.

---

## Working with Ableton Live

**As an external sample editor:**

1. In **Live Preferences → File/Folder**, set **Noise Canvas** as your _External Sample Editor_.
2. In Live, right-click a sample and select **Edit**.
3. The sample opens in Noise Canvas.
4. Make your edits, save, and close.
5. Live automatically reloads the updated version.

No exporting, importing, or manual refreshing required.

**As a Live extension (beta):** Noise Canvas also builds as an Ableton Live 12 extension (`.ablx`), which embeds the whole editor inside Live. Right-click an audio clip → **Edit in Noise Canvas**, edit, and render straight back into the set as a new clip, including **Export branch to Live** from the history panel. This requires a Live build with Extensions support and is distributed alongside each release. See [`src/extension/README.md`](../src/extension/README.md).

**Ableton Link** works regardless of which route you take. Enable it in the transport bar to lock tempo and transport to Live or anything else on the network.
