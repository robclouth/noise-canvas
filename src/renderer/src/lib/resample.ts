/**
 * `channels` resampled to `targetRate` by the audio engine's own converter.
 * Returns the same arrays when the rates already match.
 */
export async function resampleChannels(
  channels: Float32Array[],
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array[]> {
  if (channels.length === 0 || sourceRate === targetRate) return channels;

  const sourceLength = channels[0].length;
  const targetLength = Math.max(1, Math.round((sourceLength * targetRate) / sourceRate));
  const context = new OfflineAudioContext(channels.length, targetLength, targetRate);

  const buffer = context.createBuffer(channels.length, sourceLength, sourceRate);
  for (let ch = 0; ch < channels.length; ch++) buffer.getChannelData(ch).set(channels[ch]);

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();

  const rendered = await context.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, ch) => rendered.getChannelData(ch));
}
