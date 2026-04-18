const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function bandToFreq(band: number, minFreq: number, bandsPerOctave: number): number {
  return minFreq * Math.pow(2, band / bandsPerOctave);
}

export function freqToBand(freq: number, minFreq: number, bandsPerOctave: number): number {
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

export function midiToBand(midi: number, minFreq: number, bandsPerOctave: number): number {
  return freqToBand(midiToFreq(midi), minFreq, bandsPerOctave);
}

export function bandToMidi(band: number, minFreq: number, bandsPerOctave: number): number {
  return freqToMidi(bandToFreq(band, minFreq, bandsPerOctave));
}

export function isBlackKey(midi: number): boolean {
  const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
  return pitchClass === 1 || pitchClass === 3 || pitchClass === 6 || pitchClass === 8 || pitchClass === 10;
}
