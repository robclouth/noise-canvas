/**
 * The SentencePiece BPE encoder Stable Audio 3's text encoder was trained
 * with (T5Gemma's): spaces become "▁", user-defined pieces match whole and
 * never merge, the adjacent pair whose join scores highest merges first (the
 * leftmost on a tie), and a symbol left outside the vocabulary falls back to
 * its UTF-8 bytes. It adds no prefix and no begin or end token.
 */

const SPACE = "▁";

export const PIECE_NORMAL = 1;
export const PIECE_USER_DEFINED = 4;
export const PIECE_BYTE = 6;

/** One vocabulary entry; its id is its position. */
export type Piece = { piece: string; score: number; type: number };

/** The pieces of a serialised SentencePiece ModelProto, in id order. */
export function parseSentencePieceModel(bytes: Uint8Array): Piece[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let pos = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[pos++];
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return result;
      shift += 7;
    }
  };
  const skip = (wire: number): void => {
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 2) {
      const length = varint();
      pos += length;
    } else if (wire === 5) pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  };

  const pieces: Piece[] = [];
  while (pos < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field !== 1 || wire !== 2) {
      skip(wire);
      continue;
    }
    const length = varint();
    const end = pos + length;
    const entry: Piece = { piece: "", score: 0, type: PIECE_NORMAL };
    while (pos < end) {
      const innerKey = varint();
      const innerField = Math.floor(innerKey / 8);
      const innerWire = innerKey & 7;
      if (innerField === 1 && innerWire === 2) {
        const length = varint();
        entry.piece = decoder.decode(bytes.subarray(pos, pos + length));
        pos += length;
      } else if (innerField === 2 && innerWire === 5) {
        entry.score = view.getFloat32(pos, true);
        pos += 4;
      } else if (innerField === 3 && innerWire === 0) {
        entry.type = varint();
      } else {
        skip(innerWire);
      }
    }
    pieces.push(entry);
  }
  return pieces;
}

type PairCandidate = { score: number; left: number; right: number; size: number };

/** A max-heap of merge candidates: highest score first, then the leftmost. */
class Agenda {
  private readonly items: PairCandidate[] = [];

  get size(): number {
    return this.items.length;
  }

  private before(a: PairCandidate, b: PairCandidate): boolean {
    return a.score > b.score || (a.score === b.score && a.left < b.left);
  }

  push(item: PairCandidate): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop(): PairCandidate {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && this.before(items[l], items[best])) best = l;
        if (r < items.length && this.before(items[r], items[best])) best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
      }
    }
    return top;
  }
}

/** An encoder over `pieces`, returning token ids for a prompt. */
export function createTokenizer(pieces: Piece[]): (text: string) => number[] {
  const mergeable = new Map<string, number>();
  const byteIds = new Map<number, number>();
  const userDefined = new Map<string, string[]>();
  pieces.forEach((entry, id) => {
    if (entry.type === PIECE_NORMAL || entry.type === PIECE_USER_DEFINED) mergeable.set(entry.piece, id);
    if (entry.type === PIECE_BYTE) byteIds.set(parseInt(entry.piece.slice(3, 5), 16), id);
    if (entry.type === PIECE_USER_DEFINED && entry.piece.length > 0) {
      const first = String.fromCodePoint(entry.piece.codePointAt(0) ?? 0);
      const list = userDefined.get(first) ?? [];
      list.push(entry.piece);
      userDefined.set(first, list);
    }
  });
  for (const list of userDefined.values()) list.sort((a, b) => b.length - a.length);
  const encoder = new TextEncoder();

  return (text: string): number[] => {
    const normalised = text.replaceAll(" ", SPACE);
    const symbols: { piece: string; frozen: boolean; prev: number; next: number }[] = [];
    for (let pos = 0; pos < normalised.length; ) {
      const first = String.fromCodePoint(normalised.codePointAt(pos) ?? 0);
      const whole = userDefined.get(first)?.find((candidate) => normalised.startsWith(candidate, pos));
      const piece = whole ?? first;
      symbols.push({ piece, frozen: whole !== undefined, prev: symbols.length - 1, next: symbols.length + 1 });
      pos += piece.length;
    }
    if (symbols.length === 0) return [];
    symbols[symbols.length - 1].next = -1;

    const agenda = new Agenda();
    const consider = (left: number, right: number): void => {
      if (left < 0 || right < 0 || symbols[left].frozen || symbols[right].frozen) return;
      const joined = symbols[left].piece + symbols[right].piece;
      const id = mergeable.get(joined);
      if (id === undefined) return;
      agenda.push({ score: pieces[id].score, left, right, size: joined.length });
    };
    for (let i = 1; i < symbols.length; i++) consider(i - 1, i);

    while (agenda.size > 0) {
      const top = agenda.pop();
      const left = symbols[top.left];
      const right = symbols[top.right];
      if (left.piece === "" || right.piece === "" || left.piece.length + right.piece.length !== top.size) continue;
      left.piece += right.piece;
      right.piece = "";
      left.next = right.next;
      if (right.next >= 0) symbols[right.next].prev = top.left;
      consider(left.prev, top.left);
      consider(top.left, left.next);
    }

    const ids: number[] = [];
    for (let i = 0; i >= 0; i = symbols[i].next) {
      const piece = symbols[i].piece;
      const id = mergeable.get(piece);
      if (id !== undefined) {
        ids.push(id);
        continue;
      }
      for (const byte of encoder.encode(piece)) {
        const byteId = byteIds.get(byte);
        if (byteId !== undefined) ids.push(byteId);
      }
    }
    return ids;
  };
}
