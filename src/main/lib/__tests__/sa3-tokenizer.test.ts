import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getModelPath } from "../ai-separation";
import {
  createTokenizer,
  parseSentencePieceModel,
  PIECE_BYTE,
  PIECE_NORMAL,
  PIECE_USER_DEFINED,
  type Piece,
} from "../sa3-tokenizer";

const normal = (piece: string, score: number): Piece => ({ piece, score, type: PIECE_NORMAL });

function vocabulary(extra: Piece[]): Piece[] {
  const bytes = Array.from(
    { length: 256 },
    (_, b): Piece => ({
      piece: `<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`,
      score: 0,
      type: PIECE_BYTE,
    }),
  );
  return [...bytes, ...extra];
}

describe("SentencePiece BPE encoder", () => {
  it("merges the highest-scoring pair first and the leftmost on a tie", () => {
    const pieces = vocabulary([
      normal("a", 0),
      normal("b", 0),
      normal("ab", -1),
      normal("ba", -2),
      normal("aba", -3),
      normal("aa", -1),
      normal("▁", 0),
    ]);
    const encode = createTokenizer(pieces);
    const id = (piece: string): number => pieces.findIndex((p) => p.piece === piece);
    expect(encode("abab")).toEqual([id("ab"), id("ab")]);
    expect(encode("bab")).toEqual([id("b"), id("ab")]);
    expect(encode("a b")).toEqual([id("a"), id("▁"), id("b")]);
    expect(encode("aaa")).toEqual([id("aa"), id("a")]);
  });

  it("keeps a user-defined piece whole and never merges across it", () => {
    const pieces = vocabulary([
      normal("x", 0),
      normal("x<tag>", 5),
      { piece: "<tag>", score: 0, type: PIECE_USER_DEFINED },
    ]);
    const encode = createTokenizer(pieces);
    const id = (piece: string): number => pieces.findIndex((p) => p.piece === piece);
    expect(encode("x<tag>x")).toEqual([id("x"), id("<tag>"), id("x")]);
  });

  it("spells a symbol outside the vocabulary as its UTF-8 bytes", () => {
    const encode = createTokenizer(vocabulary([normal("a", 0)]));
    expect(encode("aé")).toEqual([256, 0xc3, 0xa9]);
  });
});

const TOKENIZER = getModelPath("stable-audio-3-medium/tokenizer.model");

describe.runIf(existsSync(TOKENIZER))("the Stable Audio 3 tokenizer", () => {
  it("gives SentencePiece's ids for every fixture prompt", () => {
    const encode = createTokenizer(parseSentencePieceModel(new Uint8Array(readFileSync(TOKENIZER))));
    const cases: { text: string; ids: number[] }[] = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "sa3-tokenizer-ids.json"), "utf8"),
    );
    for (const { text, ids } of cases) expect(encode(text), text).toEqual(ids);
  });
});
