// Binary framing shared by the Node extension host (encoder) and the webview
// (decoder) for shipping packed spectrogram data over the localhost server. The
// payload is mostly large typed arrays, so it travels as raw bytes with a small
// JSON header rather than JSON-stringified numbers.
//
// Wire format:
//   [u32 LE headerByteLength][header JSON utf8][section bytes, concatenated]
// header = { meta: <scalars>, sections: [{ name, kind, length }, ...] }
// Sections appear in the byte stream in header order. Bytes are copied out into
// fresh typed arrays on decode, so no buffer alignment is assumed.

export type NumericArray = Float32Array | Uint32Array | Int32Array;
type ArrayKind = "f32" | "u32" | "i32";

interface SectionHeader {
  name: string;
  kind: ArrayKind;
  length: number;
}

interface FrameHeader {
  meta: Record<string, number | string>;
  sections: SectionHeader[];
}

export interface Frame {
  meta: Record<string, number | string>;
  arrays: Record<string, NumericArray>;
}

function kindOf(array: NumericArray): ArrayKind {
  if (array instanceof Float32Array) return "f32";
  if (array instanceof Uint32Array) return "u32";
  return "i32";
}

function bytesOf(array: NumericArray): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function makeArray(kind: ArrayKind, bytes: Uint8Array): NumericArray {
  // Copy into a fresh, aligned buffer — the source offset may be unaligned.
  const copy = bytes.slice();
  if (kind === "f32") return new Float32Array(copy.buffer);
  if (kind === "u32") return new Uint32Array(copy.buffer);
  return new Int32Array(copy.buffer);
}

export function encodeFrame(frame: Frame): Uint8Array {
  const names = Object.keys(frame.arrays);
  const sections: SectionHeader[] = names.map((name) => ({
    name,
    kind: kindOf(frame.arrays[name]),
    length: frame.arrays[name].length,
  }));
  const headerJson = JSON.stringify({ meta: frame.meta, sections } satisfies FrameHeader);
  const headerBytes = new TextEncoder().encode(headerJson);

  let bodyBytes = 0;
  for (const name of names) bodyBytes += frame.arrays[name].byteLength;

  const out = new Uint8Array(4 + headerBytes.byteLength + bodyBytes);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true);
  out.set(headerBytes, 4);

  let offset = 4 + headerBytes.byteLength;
  for (const name of names) {
    const section = bytesOf(frame.arrays[name]);
    out.set(section, offset);
    offset += section.byteLength;
  }
  return out;
}

export function decodeFrame(buffer: ArrayBuffer): Frame {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buffer, 4, headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as FrameHeader;

  const arrays: Record<string, NumericArray> = {};
  let offset = 4 + headerLength;
  for (const section of header.sections) {
    // f32 / u32 / i32 are all 4 bytes per element.
    const byteLength = section.length * 4;
    const slice = new Uint8Array(buffer, offset, byteLength);
    arrays[section.name] = makeArray(section.kind, slice);
    offset += byteLength;
  }
  return { meta: header.meta, arrays };
}
