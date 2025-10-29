# Noise Canvas

Noise Canvas is a tool for doing sound design that works a bit like Photoshop for audio.  
It lets you load audio files, view them as spectrograms, and directly paint transformations and effects onto the sound.  
The interface is based around brushes, modulation, and a set of parameters that allow very flexible manipulation of sound in time and frequency.

Keep reading for a beautiful and perfectly formatted ChatGPT summary of me rambling for 5 minutes about Noise Canvas.

Otherwise just open it up and play around. All the parameters have got tooltips. I'm of the belief that how to use a tool should be mostly obvious just by using it. If it's not then I need to fix something.

---

## Core Concepts

When you load a file, it is analyzed into a **spectrogram**:

- Horizontal axis = beats (time)
- Vertical axis = semitones (pitch)

This makes the editing process musically intuitive. Instead of thinking in abstract FFT bins, you’re literally painting across beats and notes.

Noise Canvas supports working with multiple files at once. You can designate one file as the source and another as the target, which makes it easy to build audio collages or layer sounds in creative ways. The program has undo and saving, so you can experiment freely and always get back to where you were.

---

## Brushes

Brushes are the main way to interact with the spectrogram. Each brush applies a transformation to the audio under the cursor. Even though the current set is small, they cover a wide range of effects and combine in powerful ways.

### Available Brushes

- **Gain Brush**  
  Adjusts the amplitude of the spectrogram where you paint.

- **Transform Brush**  
  Applies various transformations to the spectrogram data.

- **Restore Brush**  
  Returns the painted area to the original, unedited state of the file.

### Planned Brushes

- **Blur Brush** – smooths spectrogram data in time and/or frequency.
- **Harmonics Brush** – strengthens, adds, or removes harmonics (towards saturation/distortion-like effects).
- **Noise Brush** – injects noise into the spectrogram.
- **Sharpen Brush** – increases contrast in both time and frequency; could act like transient shaping in time or edge enhancement in frequency.
- **Many more** - check the Trello below

---

## Parameters and Features

Noise Canvas includes a number of parameters that expand how brushes behave and how results are combined with the original signal.

- **Iterations**  
  Each brush stroke can be applied repeatedly in feedback. This creates complex recursive effects such as distorted echoes, spectral delays, and unstable textures.

- **Pan**  
  Processing can be done per channel, allowing stereo-aware effects.

- **Blend Modes**  
  Similar to image editors, results can be combined with the original in different ways:
  - Mix – crossfades between processed and original based on brush amount.
  - Add – adds the processed signal on top.
  - Subtract – subtracts processed values from the original.
  - Multiply – multiplies processed and original values.
  - Divide – divides one by the other.
  - Maximum – keeps the greater of the two values.
  - Minimum – keeps the lesser of the two.
  - Difference – outputs the difference between the processed and original.
  - Dissolve – noisy interpolation, similar to Photoshop’s dissolve.

- **Brush Feathering**  
  Softens the edges of the brush in time and pitch, effectively applying a windowing function around the stroke.

- **Offset Panel**  
  Allows you to offset where the brush takes input from.  
  Example: setting horizontal offset to -1 beat means painting at a point uses audio from one beat earlier. This makes temporal shifting, ghosting, and rhythmic effects straightforward.

- **Normalization**  
  The output can be normalized for consistency in loudness.

---

## Modulation

Noise Canvas has a modulation system that lets you animate parameters in time and pitch. This adds movement and makes otherwise static edits dynamic.

- Standard waveforms: sine, square, triangle, etc.
- Random and noise-based modulators: different flavors of unpredictable movement.
- Scale-based modulation: constrain modulation to a given scale, so only in-scale frequencies are affected. This makes modulation musically aware.
- Modulatable parameters have a little arrow next to the name.

By combining modulation with iterations, offsets, pan, and blend modes, you can generate highly complex evolving sounds with only a few strokes.

---

## Spectrograms and Analysis

Spectrograms are generated using the [Gaborator](https://gaborator.com/) library, based on the **Constant-Q Transform (CQT)**.

Unlike FFT, CQT adjusts time resolution depending on frequency:

- Lower frequencies → lower time resolution (smearing in time).
- Higher frequencies → higher time resolution.

This matches human hearing more closely, where we perceive pitch with more accuracy than time at low frequencies. It also avoids the “FFT sound” and gives a more natural balance between frequency and temporal resolution. Kick drums and bass notes will appear smeared at the low end, which is an expected artifact.

Analysis properties are adjustable, so you can favor frequency resolution or time resolution depending on your needs.

---

## Integration with Ableton Live

Noise Canvas is designed to work smoothly with Ableton Live:

1. In Live, click _Edit_ on a sample.
2. The file opens in Noise Canvas.
3. After editing, save and close.
4. Live automatically updates the sample with your edits.

This makes it possible to drop Noise Canvas into a standard production workflow without friction.

---

## Technical Overview

- Built with **Electron**, **TypeScript**, and **React**
- **React Three Fiber** for WebGL rendering
- **GLSL shaders** for DSP processing (GPU accelerated)
- **Gabberator** for spectrogram generation
- Constant-Q Transform for analysis

---

## Status

Noise Canvas is still in development. Stability is not guaranteed, but issues will be tracked and fixed when I can be arsed.

Current tasks, bugs, and ideas can be found here:  
[Trello board](https://trello.com/b/P2vcaaZI/noise-canvas)

---

## Contributing

Contributions are welcome woth caveats. If you’d like to get involved, reach out to discuss features and direction so efforts stay aligned. Alternatively, fork the project and explore your own path but on the main fork I'll have the final say.

---

## Building

On Mac and Linux you should just be able to clone the repo then `npm i`.
On Windows run the official node.js installer, and make you sure choose to auto install the native build tools. Search for 'Visual Studio Installer', open it and nodifying the build tools installation. Make sure Windows 11 SDK is installed on the right-hand panel. Then `npm i`. God I hate Windows.

---

## Credits

- [3dtextures.me](https://3dtextures.me/) for the textures.
- [Gaborator](https://gaborator.com/) for the analysis.

## License

Noise Canvas uses the GNU Affero General Public License v3 (AGPL-3.0).  
<one line to give the program's name and a brief idea of what it does.>

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.
See [LICENSE.md](./LICENSE.md) for the full legal text.

In short, this license allows you to use, study, share, and modify the software freely.  
If you distribute modified versions or make the software available over a network, you must also provide the source code under the same license.  
The software is provided without warranty and is offered “as is.”

## Copyright (C) 2025 Rob Clouth
