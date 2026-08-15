# Noise Canvas — Recipes

Things to actually do with it. The [manual](./manual.md) tells you what each control is; this tells you what to reach for.

Each recipe is **Goal → Set up → Do → Variations**. Settings not mentioned are left at their defaults, so start from a **New** brush unless a recipe says otherwise.

> **Status: unverified.** Every recipe below is derived from the parameter definitions and the factory presets, and none has been played back and listened to yet. Treat the settings as a starting point until that pass is done.

## Contents

- [Rhythm](#rhythm) — [Chop to the hits](#chop-to-the-hits) · [Rearrange beats](#rearrange-beats) · [Erase a hit](#erase-a-hit) · [Turn a pad into a rhythm](#turn-a-pad-into-a-rhythm) · [Paint a rhythm across the file](#paint-a-rhythm-across-the-file) · [Sweep a brush up the spectrum](#sweep-a-brush-up-the-spectrum)
- [Pitch and time](#pitch-and-time) — [Pitch up or down](#pitch-up-or-down) · [Reverse a phrase](#reverse-a-phrase) · [Half speed](#half-speed) · [Harmonise](#harmonise)
- [Space and texture](#space-and-texture) — [Reverb from nothing](#reverb-from-nothing) · [Reverse reverb](#reverse-reverb) · [Freeze and smear](#freeze-and-smear) · [Build a hat from noise](#build-a-hat-from-noise)
- [Repair](#repair) — [Undo one region](#undo-one-region) · [Mute a vocal](#mute-a-vocal)

---

## Rhythm

### Chop to the hits

**Goal.** Cut a break into its individual hits without hunting for the edges by hand.

**Set up.**

- Transport: **Beats = Onsets**, **Snap** on.
- Options: **Anchor = Corner**.
- Envelope: **Size ↔ = Grid** — with an onset grid this makes one stroke exactly one hit, edge to edge.

**Do.** Click on a hit. The stroke lands on the transient rather than near it, and stops where the next one starts.

**Variations.** Lower the file header's **Onsets** sensitivity if a busy loop is finding hits you don't hear; raise it if quiet ghost notes are being missed. Everything below in this section works better with this set up first.

_See also:_ [Onsets](./manual.md#onsets), [Options](./manual.md#options).

### Rearrange beats

**Goal.** Put the snare from beat 3 onto beat 1, without cutting anything up.

**Set up.**

- Chop to the hits, above.
- Source: **Shift+click** the hit you want on beat 3 — a brush-sized rectangle previews what you'll be sampling.
- Source: **Tracking = Fixed**, so every stroke reads that same spot.

**Do.** Paint on beat 1. Repeat anywhere else you want it.

**Variations.** **Tracking = Anchored** keeps the offset instead, so dragging moves source and destination together — good for sliding a whole bar. **Blend mode = Add** layers the hit over what's there instead of replacing it.

_See also:_ [Source](./manual.md#source), [Blend Modes](./manual.md#blend-modes).

### Erase a hit

**Goal.** Take one hit out of a loop and leave the rest untouched.

**Set up.**

- The **Eraser** factory brush (Dynamics with Gain at the bottom).
- Chop to the hits, above.

**Do.** Paint on the hit.

**Variations.** For a partial removal, raise Dynamics **Gain** off the floor, or drop brush **Strength** — both leave some of it behind. To erase only the low end of a hit, set **Size ↕** small and place the stroke on the fundamental.

_See also:_ [Dynamics](./manual.md#dynamics).

### Turn a pad into a rhythm

**Goal.** Get a pulse out of something with no transients in it at all.

**Set up.** Take the **Step Gate** factory brush apart — it is exactly this:

- Effects: **Dynamics**, Gain at 0 dB.
- On Dynamics **Gain**, click the label and set **Modulator 1** to **−100%**, so the modulator drives gain across its full range downwards.
- Modulator 1: **Mode = Sequence**, 8 steps, 1 row, **Loop = 2 beats**, and draw the pattern you want.
- Envelope: **Size ↔ = 4 beats**, **Size ↕ = Full**, both **Curves = +100%** so the stroke is a hard rectangle rather than a fade.

**Do.** Paint across a bar of the pad.

**Variations.** Swap the sequencer for **Mode = Pattern**, **Shape = Square**, **Rate ↔ = 1/4** for a straight gate, or **Shape = Sine** for a tremolo. Set the sequencer to several rows and it gates pitch bands independently — the pad becomes a chord that flickers.

_See also:_ [Modulator Modes](./manual.md#modulator-modes), [How Modulation Amount Works](./manual.md#how-modulation-amount-works).

### Paint a rhythm across the file

**Goal.** Apply a brush on every offbeat of a whole loop without placing a single stroke by hand.

**Set up.**

- Pick the brush you want painted — it's whatever is selected.
- Set the time grid to the spacing you want, an eighth for offbeats, and leave **Size ↔** on **Grid** so each stroke fills its cell.
- Drag on the time legend if you only want part of the file covered.

**Do.** Click the grid icon on the file header, or press `Cmd/Ctrl+G`. The whole pass is one stroke and one undo step.

**Variations.** Put a **sequencer** modulator on **Strength** and draw the rhythm you want — `1 0 0 1 0 0 1 0` gives a three-against-eight. A Random pattern modulator on Strength varies each stroke instead, and taking its depth down far enough drops some of them. Set the time grid to **Onsets** and the fill follows the file's own hits.

_See also:_ [Fill Grid](./manual.md#fill-grid), [Transport and Output](./manual.md#transport-and-output).

### Sweep a brush up the spectrum

**Goal.** March one effect from the bass to the top over a bar, in even steps.

**Set up.**

- Set the pitch grid **Semis** to a quarter of your file's range, and leave **Size ↕** on **Grid** so each stroke fills its row.
- Set the time grid to a beat, so the fill steps across time as it climbs.

**Do.** **Fill Grid** from the file header, or `Cmd/Ctrl+G`.

**Variations.** Set the pitch grid to **Scale** and every stroke lands on a note of the selected scale instead of a fixed interval. A pattern modulator on **Strength**, set slower than the grid, fades the fill in as it climbs, because a modulator is a field across the canvas and each stroke samples where it lands.

_See also:_ [Where in the Spectrum](./manual.md#where-in-the-spectrum), [Strength, Pan and Macros](./manual.md#strength-pan-and-macros).

---

## Pitch and time

### Pitch up or down

**Goal.** Move something in pitch and have it still sound like itself.

**Set up.**

- Effects: **Transform**, **Shift ↕** to the interval you want in semitones.
- Options: **Warp algo** — this is the choice that matters. **Percussive** for drums and anything with attacks; **Neutral** for pads and sustained tone; **Neutralish** if Neutral is too clean.

**Do.** Paint over the region.

**Variations.** **Flangey** keeps the stored phase and comes out metallic and comb-filtered; **Noisey** randomises it into something diffuse and airy. Both are worth trying deliberately rather than avoiding. Shifting up an octave with **Blend mode = Add** gives you a doubled octave rather than a replaced one.

_See also:_ [Warp Algorithms](./manual.md#warp-algorithms), [Transform](./manual.md#transform).

### Reverse a phrase

**Goal.** Flip one phrase backwards inside an otherwise forwards file.

**Set up.** The **Reverse** factory brush: Transform with **Scale ↔ = −1**, **Edge = Cut**, hard rectangular envelope.

**Do.** Paint over the phrase. The window you paint is what gets mirrored — Edge = Cut is what stops neighbouring audio being dragged into it.

**Variations.** **Scale ↕ = −1** flips pitch instead, turning a rising line into a falling one about the middle of the brush.

_See also:_ [Transform](./manual.md#transform).

### Half speed

**Goal.** Stretch the whole file to twice its length.

**Set up.**

- **Edit → Double Length** first, so there is somewhere for it to go.
- Effects: **Transform**, **Scale ↔ = 2**.
- Envelope: **Size ↔ = Full**, **Size ↕ = Full**.
- Options: **Warp algo = Neutral**.

**Do.** One stroke.

**Variations.** **Scale ↔ = 0.5** after **Half Length** does the opposite. Because time and pitch are independent here, the pitch does not move — add **Shift ↕ = −12** if you want the tape-speed version.

_See also:_ [Transform](./manual.md#transform), [Menus](./manual.md#menus).

### Harmonise

**Goal.** Add a harmony line rather than replacing the original.

**Set up.** Either:

- Effects: **Repeat**, **Gap ↕ = 7** semitones, **Copies ↕ = 1**, **Direction ↕ = Up** — one copy a fifth above. Or:
- Effects: **Repeat**, **Shape ↕ = Scale**, **Gap ↕ = 3**, **Copies ↕ = 3**, and set the scale in the transport bar — chords that stay in key.

**Do.** Paint over the melody.

**Variations.** **Repeat Decay** fades the outer copies, so a stack of four reads as one voice with overtones rather than four voices. **Gap ↕ = 12** gives octaves instead, and **Shape ↕ = Harmonic** gives the natural harmonic series.

_See also:_ [Repeat](./manual.md#repeat).

---

## Space and texture

### Reverb from nothing

**Goal.** A tail on a dry sound, without an impulse response.

**Set up.**

- Effects: **Blur**, **Blur ↔** up, **Origin = Left** so the smear runs forwards in time rather than both ways.
- **Samples ↔** higher if the tail sounds grainy.

**Do.** Paint over the sound, extending past its end — the tail has to have somewhere to go.

**Variations.** A little **Blur ↕** widens it in pitch as well and the tail gets less like the source. **Noise ↔** roughens the smear into something more diffuse. Modulate **Blur ↔** from an **Envelope** modulator tracking Amplitude and the reverb only opens on the loud parts — that is the **Dynamic Bloom** factory brush.

_See also:_ [Blur](./manual.md#blur).

### Reverse reverb

**Goal.** The swell that runs into a hit.

**Set up.**

- Effects: **Convolve**, **IR** set to the bundled reverb impulse.
- **Rate = −1**, which steps backwards through the source for each tap.

**Do.** Paint over the bar leading up to the hit.

**Variations.** **IR Start** past the attack keeps only the tail of the room. **IR Pitch Shift** moves the room's resonances, so the same IR can be a small bright space or a large dark one. **|Rate| > 1** stretches the tail out.

_See also:_ [Convolve](./manual.md#convolve).

### Freeze and smear

**Goal.** Hold one moment open across a whole bar.

**Set up.**

- Effects: **Blur**, **Blur ↔ = 100%**.
- Envelope: **Size ↔** wide, curve **+100%** so it doesn't fade in and out.

**Do.** Paint from the moment you want frozen across the bar.

**Variations.** **Iterations** above 1 re-runs the blur inside one stroke and the freeze goes further with less brush size. Add **Evolve** after the Blur, with a little **Flow** and **Spread**, and the frozen texture drifts instead of sitting still.

_See also:_ [Blur](./manual.md#blur), [Evolve](./manual.md#evolve), [Options](./manual.md#options).

### Build a hat from noise

**Goal.** A hi-hat that was never recorded.

**Set up.**

- Effects: **Synthesize**, **Type = Impulse**, then **Align** after it.
- Envelope: **Size ↔ = Grid** on a small time grid, **Curve ↔ = −100%** for a sharp spike, **Skew ↔ = −100%** so the peak is at the start.
- Envelope: **Size ↕** covering the top few octaves only.

**Do.** Paint on the offbeats.

**Variations.** **Type = Noise** with the same envelope gives you a snare rather than a hat. Widen **Size ↕** downwards and it becomes a crash. Modulating **Strength** from **Randomize** gives every stroke a different velocity.

_See also:_ [Synthesize](./manual.md#synthesize), [Align](./manual.md#align), [Envelope](./manual.md#envelope), [Contextual Sources](./manual.md#contextual-sources).

---

## Repair

### Undo one region

**Goal.** Take back one part of an edit without losing everything you did after it.

**Set up.** The **Restore** factory brush: no effects, **Read From = Original**, **Blend mode = Mix**.

**Do.** Paint over the region you regret. It reads from the file's unedited analysis, so that area comes back and nothing else moves.

**Variations.** Lower brush **Strength** to blend part of the original back in rather than all of it. This is a surgical alternative to walking the [history](./manual.md#history) tree — the tree undoes in time, this undoes in place.

_See also:_ [Source](./manual.md#source), [History](./manual.md#history).

### Mute a vocal

**Goal.** Take the voice out and keep the backing.

**Set up.**

- File header → **scissors** → **Split Drums / Bass / Other / Vocals (AI)**. Not on Intel Macs; the model downloads once.
- The vocal stem opens as an ordinary file alongside the others, bracketed as a [stem group](./manual.md#stem-groups).

**Do.** Erase on the vocal stem — the **Eraser** brush, **Size ↕ = Full**, painted across the parts you want gone. Then **Merge** the group back.

**Variations.** Because merging is lossless in the coefficient domain, you can split, edit one part heavily, and merge back without the round trip costing you anything. Erasing only some of the vocal — say, a low **Strength** across the whole thing — buries it rather than removing it.

_See also:_ [Splitting a File](./manual.md#splitting-a-file), [Stem Groups](./manual.md#stem-groups).
