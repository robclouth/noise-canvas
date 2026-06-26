# Bundled sample licenses

Audio files shipped with Noise Canvas and referenced by factory brushes via the
`bundled://` path scheme. Each entry lists the file, its source, and its license.

| File            | Description                                                                                              | Source                                                                         | License                            |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `pad-loop.mp3`  | Warm sustained A-minor pad with slow tremolo/vibrato, used as a source sample for the **Sampler** brush. | Original, synthesized for this project (ffmpeg sine oscillators).              | CC0 1.0 (public domain dedication) |
| `reverb-ir.mp3` | Exponentially decaying band-limited noise reverb impulse response, used by the **Convolution** brush.    | Original, synthesized for this project (ffmpeg pink-noise + exponential fade). | CC0 1.0 (public domain dedication) |

CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/

When adding new bundled samples, place the audio file in this directory and add a
row here with its source and license. Only CC0 / public-domain / permissively
licensed audio should be bundled, with attribution recorded above where required.
