# Copy Style Guide

The rules for every word a user reads: parameter labels and descriptions, effect
names and blurbs, control tooltips, tour steps, and this manual. It exists so
that 200-odd strings written at different times read as one voice.

Enforced by `description-voice.test.ts`, `control-coverage.test.ts` and
`docs-drift.test.ts`. A rule that can be checked is checked.

---

## 1. One idea, three depths

Every feature is described in three places, each answering a different question.
Nothing repeats between them.

| Surface                     | Answers                    | Budget                                   |
| --------------------------- | -------------------------- | ---------------------------------------- |
| **Label**                   | What is this called?       | 1–3 words                                |
| **Description** (= tooltip) | What does it do?           | One sentence, ≤ 120 characters           |
| **Manual**                  | What do the settings mean? | As long as it needs, in a fixed skeleton |

If a description needs a second sentence, the second sentence belongs in the
manual. The manual is the last layer: there is nothing deeper to push into.

---

## 2. Descriptions

**Say what it does to the sound.** Verb first, present tense, one sentence,
ending in a full stop.

> Sets how far the modulator swings.
> Spaces the copies evenly, by the harmonic series, by doubling gaps, stretched, or on the selected scale.
> Slides the sound up or down, in semitones.

**Start with the verb the control performs.** `Sets`, `Picks`, `Moves`, `Adds`,
`Spaces`, `Locks`, `Repeats`, `Fades`. Never open with `The`, `Controls`,
`Whether`, `How`, `A`, `An` — those sentences are about the control, not the
sound.

**Never restate the label.** A label of "Decay" with a description of "The decay
amount" costs a hover and gives nothing back.

### Not in a description

| Out                                                      | Why                                            | Goes to      |
| -------------------------------------------------------- | ---------------------------------------------- | ------------ |
| Advice — "Corner for rhythm, Center for pads."           | It is a suggestion, not a definition.          | Manual hints |
| Sentence fragments — "Echoes, feedback, spectral delay." | Not a sentence.                                | Manual hints |
| Mode-by-mode lists                                       | Six modes will not fit in one sentence.        | Manual table |
| Mechanism — "Soft-clips each bin's magnitude."           | Describes the code, not the result.            | Cut          |
| Ranges and units the control shows                       | "(1–64)", "in dB" when the control has a unit. | Cut          |
| Second person — "use a pattern modulator slower than…"   | Instructions belong in prose.                  | Manual       |

Keep a unit inside the sentence only where it is the point: "Slides the sound up
or down, **in semitones**" earns it, because the axis is what the reader wants.

### Length

One sentence, ≤ 120 characters. After the sweep the spread is 27–114 characters
with a median of 60. What made the long ones long was advice or a mode list, and
both belong elsewhere.

### Effect descriptions

An effect card is the one place the copy has to earn a click. A reader is
choosing between ten of them and knows none of the names, so a card that only
states the operation is accurate and useless.

**Say what it does, then what it becomes.** One sentence in two clauses, joined
by a comma or a colon: the operation first, the sound it produces second. Third
person, verb first, **≤ 80 characters**, which is three lines in the picker's
two-column card and the point at which a fourth starts.

> Smears energy across time and pitch, into reverb tails, freezes and soft edges.
> Reorders the bands by loudness or phase, banking them into glitched stripes.

**The second clause names a sound, not a use.** This is the line that keeps the
warmth without turning the card into advice:

| Allowed — what it sounds like        | Banned — what to do with it        |
| ------------------------------------ | ---------------------------------- |
| "into echoes and stacked harmonies"  | "great for pads and drones"        |
| "chopped, squashed or hollowed out"  | "use it to tighten up a drum loop" |
| "rooms, plates and resonant objects" | "perfect for lo-fi hip hop"        |

The test is grammatical, not editorial: an allowed clause is a noun phrase
naming the result, and a banned one is a verb aimed at the reader or a genre.
So the ban on the second person, on "for", and on genre names still holds.

---

## 3. Labels

The label column is 70 px wide, and 58 px with Compact UI on. At the 11 px UI
font that is about **12 characters, or 10 in Compact**. The transport column is
40 px, or **7 characters**. A label that overflows is worse than an
abbreviation, so:

- **Never make a label longer than it already is.** Existing abbreviations stay:
  "Dir. ↔", "Warp Algo.", "Semis". Shorten where the meaning survives.
- **Title Case.** "Grid Size Beats", "Sort By", "Scale Tonic".
- **Abbreviate by truncating with a full stop** — "Dir.", "Algo.", "Freq." —
  never by dropping vowels or inventing a short form.
- **`name` is the full identity** ("Brush Skew Time"); **`label` is what fits
  next to the control** ("Skew ↔"). Both are Title Case.
- **Axis suffixes are always ↔ (time) and ↕ (pitch)**, never "X/Y",
  "Horizontal", or the word "Time"/"Pitch" where the arrow will do.
- **No units in a label.** The control shows the unit.

---

## 4. The manual

Written for someone making music, not someone reading the source.

### Section skeleton

1. **What it does** — one or two sentences.
2. **Controls** — one line each, in the order they appear on screen.
3. **Hints** — optional, a short bullet list of things worth trying.

Lists of modes always use a two-column table (**Mode | What it does**), never a
bullet list. A table nested inside a bullet does not survive the in-app viewer,
so the table goes below the Controls list and the bullet points at it.

### Hints

Where the advice cut from descriptions lands. One line each, in the imperative,
at the end of the section it belongs to:

> **Hints**
>
> - Set Anchor to Corner for rhythmic strokes, so snapping locks hits to the grid.
> - Set it to Centre for pads, so snapping puts the envelope peak on the grid.

**A hint has to be worth reading.** If every section carries one, the heading
stops meaning anything and readers skip all of them. So:

- **Most sections have none.** A hint exists only where a control does something
  useful that is not obvious from what it does — a combination, a setting at an
  extreme, an interaction with another control.
- **At most two per section.**
- **Never a restatement.** "Turn up Blur ↔ for more blur" is not a hint.

Anything longer than a line is not a hint. Fold it into the prose above, or cut
it.

### Not in the manual

**Anything the reader cannot act on.** A true sentence that changes nothing is
still padding. Guarantees that hold silently, behaviour that never varies, and
reassurance that a feature works are answers to questions nobody asked: the
reader learns only that there was once a doubt. This is the general rule, and
most of what follows is a special case of it.

Ask what the reader would do differently for knowing. If the answer is nothing,
cut it.

- Cut: "It is the same at every resolution, so a file that opens can always be
  re-analysed at another one." Nothing to do, and no way to see it.
- Cut: any sentence whose point is that something behaves correctly.
- Keep: "Files run to a little over five minutes at 44.1 kHz." That is a wall
  the reader hits.

**Implementation.** Name a mechanism only when knowing it changes what the
reader would do. "Adjusts time resolution with frequency, so low notes are
accurate in pitch and high ones sharp in time" earns its place — it tells you
what to expect from an edit. These do not:

- "Odd-even transposition sort of the spectrogram bins"
- "A reaction–advection–diffusion simulation"
- "HRTF-based binaural spatialization"
- "Waveshaper distortion applied to the rectangular (real/imaginary) spectral components"
- "the unrolled shader loops it produces make compile times unusable"

**What the app cannot do, and why.** State a limit only where the reader will
hit it and think something is broken. Never state the reason.

- Cut: "It is always there and has nothing to set." Nothing to do.
- Cut: "Saves are atomic, so a crash mid-write can't corrupt your file."
- Keep, but shorten to the fact: "Not available on Windows."

**Anything the picker does not offer.** Waveshape and Align are
hidden, so they leave the manual completely — sections, contents list, and the
note that explains their absence. A feature the reader cannot reach is not
documented.

**Names of shipped content.** The manual never names a section preset, a
factory palette, or a brush inside one. They get added, renamed and dropped
without the manual hearing about it, and a named one is a broken reference the
moment that happens. Say that some come with the app, and describe settings
rather than pointing at a preset — "Mag.→Mag. with Curve at −1" stays true
whatever the preset list does.

**Sales copy.** "This approach makes sound design tangible — almost physical.
You're literally painting timbre." Show it with an instruction instead.

**Restating every parameter.** The tooltip already carries the one-sentence
definition. A manual bullet exists to add what the sentence could not hold: what
the modes mean, how it interacts with something else, what the extremes sound
like.

---

## 5. Spelling and typography

- **British English throughout**: colour, centre, centred, favour, behaviour,
  metre, grey.
- **`-ise`, not `-ize`**: randomise, normalise, minimise, synthesise, and
  analyse. This reaches labels: the dice is **Randomise**, the effect is
  **Synthesise**, the menu item is **Re-analyse File**.
- **Code is not copy.** Identifiers, object keys, CSS and file names keep their
  current spelling (`randomize-dice`, `synthesize`, `normalizeIr`). Only the
  strings a user reads change.
- **Sentence case in descriptions and manual prose**, Title Case in labels and
  headings.
- **En dash for ranges** (`1–64`), minus sign for negatives (`−100%`). No em
  dashes: use a comma, colon, or full stop instead. An em-dash aside reads as
  machine-written.
- **A band is a band.** In user copy, the pitch rows are **bands**, never
  "bins". "Bin" is a code word.
- **Names, fixed**: brush, step, stroke (one brush application, click or drag),
  canvas, dock, source file, spectrogram, transport, grid, scale.

---

## 6. Worked examples

Real strings, before and after. Each "after" obeys every rule above; the
displaced material is shown where it goes.

### Parameter descriptions

**Anchor**: 195 characters, carrying two mode meanings and a suggestion.

> **Before** Puts the cursor on the stroke's bottom-left onset corner, so snapping locks hits to the grid, or on its centre, so snapping lands the envelope peak on the grid. Corner for rhythm, Center for pads.
>
> **After** Sets where the cursor sits on the brush, which decides what snapping locks to the grid.
>
> **Manual** Corner puts it on the bottom-left corner, on the onset. Centre puts it on the brush centre, on the envelope peak.
>
> **Hint** Set Anchor to Corner for rhythmic strokes and to Centre for pads.

**Skew ↔**: 224 characters, the longest in the app.

> **Before** Moves the envelope peak through time: −100% is an early pluck, 0% centred, +100% a delayed hit. Contextual Time modulation flattens the envelope instead — use a pattern modulator slower than the brush for a peak that slides.
>
> **After** Moves the envelope peak earlier or later in the stroke.
>
> **Manual** −100% is an early pluck, 0% is centred, +100% is a delayed hit. Contextual Time modulation flattens the envelope rather than moving its peak.
>
> **Hint** Modulate Skew ↔ with a pattern slower than the brush for a peak that slides from stroke to stroke.

**Magnitude Limit**: mechanism, a code word, and an aside.

> **Before** Soft-clips each bin's magnitude. 0 turns it off — raise it only to stop a feedback effect running away, since the audio limiter already keeps the output safe.
>
> **After** Caps how loud any one band can get. 0 turns it off.

**Beats**: a second sentence explaining another setting.

> **Before** Spaces the time grid, in beats. Set it to 'Onsets' to snap to the file's detected hits instead, which lands a stroke exactly on a transient rather than near it.
>
> **After** Spaces the time grid, in beats.
>
> **Manual** Set it to Onsets and the grid follows the file's detected hits instead of a fixed division.
>
> **Hint** Snap to onsets with Anchor on Corner, and a stroke lands exactly on a transient rather than near it.

**Iterations**: a trailing fragment.

> **Before** Re-runs the whole effect chain this many times inside one stroke, feeding its own output back in. Echoes, feedback, spectral delay.
>
> **After** Repeats the whole effect chain inside one stroke, feeding each pass back in.
>
> **Hint** Two or three iterations turn one effect into echoes and spectral delays.

**Auto-limit**: mechanism plus advice.

> **Before** Holds each stroke's own level down as you paint it, leaving the audio around it untouched. Turn it off to paint as loud as the effect makes it.
>
> **After** Stops the output clipping, on playback and on export.
>
> **Hint** Switch Auto-limit off to paint as loud as the effect makes it, and watch the level strip for clipping.

**Noise ↔**: spelling and length.

> **Before** Randomizes each time-axis blur tap, roughening the smear into something grainier.
>
> **After** Randomises each blur tap along time, roughening the smear.

**Already correct**, and left alone: "Sorts along time or along pitch.",
"Slides the sound up or down, in semitones.", "Holds this step's effect chain,
applied top to bottom.", "Sets the scale's root note."

### Effect descriptions

The full set, rewritten to the two-clause rule. The old ones mix second person
("Squash", "Let the sound") with third ("Reorder"), and hang the character off
the end as a fragment; these fold it into the sentence instead.

| Effect     | Before                                                                     | After                                                                           |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Dynamics   | Squash, gate, expand or invert whatever the brush covers.                  | Compresses, gates, expands or inverts each band, into chopped and hollow sound. |
| Transform  | Move sound through time and pitch — shift, stretch, rotate, reverse.       | Slides, stretches and rotates the sound through time and pitch, or reverses it. |
| Blur       | Smear energy across time and pitch. Reverb, freeze, and soft edges.        | Smears energy across time and pitch, into reverb tails, freezes and soft edges. |
| Repeat     | Copy what's there at beat and semitone offsets. Echoes and harmonies.      | Copies the sound at beat and semitone offsets, into echoes and stacked chords.  |
| Synthesise | Paint new sound from nothing — noise, tones, impulses.                     | Fills the brushed area with noise, tones or impulses: sound out of nothing.     |
| Evolve     | Let the sound grow and flow on its own, into fluid or chaotic textures.    | Grows, spreads and decays the sound on its own, into fluid, unpredictable life. |
| Binaural   | Place sound anywhere around the listener's head, in 3D.                    | Places the sound around the listener's head: left, right, close, far, behind.   |
| Sort       | Reorder the bins by loudness or phase. Glitched, banded, pixel-sorted.     | Reorders the bands by loudness or phase, banking them into glitched stripes.    |
| Convolve   | Print the character of another sound onto this one. Reverbs and room tone. | Prints another sound's character onto this one: rooms, plates, resonant junk.   |
| Attract    | Pull energy toward a map — the scale, the grid, or the sound's own peaks.  | Pulls energy onto a map of valleys, gathering smear into notes and hits.        |

Each keeps the operation in the first clause, so a reader who wants only the
fact can stop at the comma. A description must not open with its own label:
Repeat is "Copies…", not "Repeats…".

### Manual prose

> **Before** Odd-even transposition sort of the spectrogram bins — pixel-sorting, for sound.
>
> **After** Reorders the bands inside the brush, so loud content collects at one edge and the rest banks up behind it. It reads as stripes, bands and digital smear.

> **Before** A reaction–advection–diffusion simulation, for fluid, biological, and chaotic patterns.
>
> **After** Grows, spreads and decays the sound on its own, into fluid, biological or chaotic textures. It is the least predictable effect here, and rewards small values.

> **Before** HRTF-based binaural spatialization for 3D placement of the painted region.
>
> **After** Places the painted sound anywhere around the listener's head, in 3D. It is made for headphones. On speakers you mostly hear it as width.

> **Before** A thin strip sits directly above each file's spectrogram, showing how loud the finished audio is at every moment. It is always there and has nothing to set.
>
> **After** A thin strip sits directly above each file's spectrogram, showing how loud the finished audio is at every moment.

> **Before** Nested modulation is disabled on Windows, where the unrolled shader loops it produces make compile times unusable.
>
> **After** Not available on Windows.

> **Before** This approach makes sound design tangible — almost physical. You're literally painting timbre.
>
> **After** (cut)

> **Before** Saves are atomic, so a crash mid-write can't corrupt your file.
>
> **After** (cut: nothing to act on)

### Labels

Same length or shorter, in British English.

| Before     | After      | Why                         |
| ---------- | ---------- | --------------------------- |
| Randomize  | Randomise  | British spelling            |
| Minimize   | Minimise   | British spelling            |
| Synthesize | Synthesise | British spelling            |
| Center     | Centre     | British spelling            |
| Favorite   | Favourite  | British spelling            |
| Blend mode | Blend Mode | Title Case                  |
| Dir. ↔    | Dir. ↔    | Fits; left alone            |
| Warp algo  | Warp Algo. | Title Case, truncation mark |
