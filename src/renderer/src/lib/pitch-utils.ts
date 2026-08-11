const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// These count bands upward from the file's lowest, which is the opposite
// direction to a packed-data band index (see lib/utils for the spaces).
export function bandsAboveMinToFreq(bandsAboveMin: number, minFreq: number, bandsPerOctave: number): number {
  return minFreq * Math.pow(2, bandsAboveMin / bandsPerOctave);
}

export function freqToBandsAboveMin(freq: number, minFreq: number, bandsPerOctave: number): number {
  return Math.log2(freq / minFreq) * bandsPerOctave;
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pitchClass]}${octave}`;
}

export function midiToBandsAboveMin(midi: number, minFreq: number, bandsPerOctave: number): number {
  return freqToBandsAboveMin(midiToFreq(midi), minFreq, bandsPerOctave);
}

export function bandsAboveMinToMidi(bandsAboveMin: number, minFreq: number, bandsPerOctave: number): number {
  return freqToMidi(bandsAboveMinToFreq(bandsAboveMin, minFreq, bandsPerOctave));
}

export function isBlackKey(midi: number): boolean {
  const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
  return pitchClass === 1 || pitchClass === 3 || pitchClass === 6 || pitchClass === 8 || pitchClass === 10;
}
