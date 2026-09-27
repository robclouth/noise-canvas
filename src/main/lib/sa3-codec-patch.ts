/**
 * Bytes appended to the Stable Audio 3 Medium codec's ONNX files so stock ONNX
 * Runtime can run them. Protobuf merges a message that appears twice, so an
 * appended ModelProto adds its repeated fields to the file's own.
 *
 * `functionPatch` defines `samel.diff_attn_swa` from standard opset-17 ops.
 * q, k, v are (B, N, 2H, D); heads [0, H) and [H, 2H) each attend to keys at
 * most 17 positions away, scaled by 1/8, and the op returns the first half
 * minus the second, (B, N, H, D). It computes in float32 and returns the input
 * type. Keys are read three blocks of 17 at a time, so the cost is linear in N.
 *
 * `floatOutputPatch` adds the decoder's float audio as a graph output, ahead
 * of the 16-bit clip its `pcm` output applies.
 */

const WINDOW = 17;
const BLOCK = 17;
const SPAN = 3 * BLOCK;
const NEG = -30000;
/** The decoder tensor that holds float audio before the clip. */
export const DECODER_FLOAT_OUTPUT = "/Cast_output_0";

const DATA_FLOAT = 1;
const DATA_INT64 = 7;
const ATTR_INT = 2;
const ATTR_TENSOR = 4;
const ATTR_INTS = 7;

class ProtoWriter {
  private readonly bytes: number[] = [];

  private varint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    while (v >= 0x80n) {
      this.bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.bytes.push(Number(v));
  }

  int(field: number, value: number | bigint): this {
    this.varint(BigInt((field << 3) | 0));
    this.varint(BigInt(value));
    return this;
  }

  raw(field: number, data: Uint8Array): this {
    this.varint(BigInt((field << 3) | 2));
    this.varint(BigInt(data.length));
    for (const byte of data) this.bytes.push(byte);
    return this;
  }

  string(field: number, value: string): this {
    return this.raw(field, new TextEncoder().encode(value));
  }

  message(field: number, message: ProtoWriter): this {
    return this.raw(field, message.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

type Tensor = { dims: number[]; type: typeof DATA_FLOAT | typeof DATA_INT64; values: number[] | bigint[] };

function tensorProto(name: string, tensor: Tensor): ProtoWriter {
  const w = new ProtoWriter();
  for (const dim of tensor.dims) w.int(1, dim);
  w.int(2, tensor.type);
  w.string(8, name);
  const raw =
    tensor.type === DATA_FLOAT
      ? new Uint8Array(Float32Array.from(tensor.values as number[]).buffer)
      : new Uint8Array(BigInt64Array.from((tensor.values as (number | bigint)[]).map((v) => BigInt(v))).buffer);
  return w.raw(9, raw);
}

type Attribute = { name: string; int?: number; ints?: number[]; tensor?: { name: string; value: Tensor } };

function attributeProto(attribute: Attribute): ProtoWriter {
  const w = new ProtoWriter().string(1, attribute.name);
  if (attribute.int !== undefined) return w.int(3, attribute.int).int(20, ATTR_INT);
  if (attribute.tensor)
    return w.message(5, tensorProto(attribute.tensor.name, attribute.tensor.value)).int(20, ATTR_TENSOR);
  for (const value of attribute.ints ?? []) w.int(8, value);
  return w.int(20, ATTR_INTS);
}

function node(op: string, inputs: string[], outputs: string[], attributes: Attribute[] = []): ProtoWriter {
  const w = new ProtoWriter();
  for (const input of inputs) w.string(1, input);
  for (const output of outputs) w.string(2, output);
  w.string(4, op);
  for (const attribute of [...attributes].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    w.message(5, attributeProto(attribute));
  }
  return w;
}

const constant = (name: string, value: Tensor): ProtoWriter =>
  node("Constant", [], [name], [{ name: "value", tensor: { name, value } }]);
const int64 = (values: number[], dims: number[] = [values.length]): Tensor => ({ dims, type: DATA_INT64, values });
const float32 = (values: number[], dims: number[]): Tensor => ({ dims, type: DATA_FLOAT, values });

function bandMask(): number[] {
  const values: number[] = [];
  for (let q = 0; q < BLOCK; q++) {
    for (let w = 0; w < SPAN; w++) values.push(w >= q && w <= q + 2 * WINDOW ? 0 : NEG);
  }
  return values;
}

function functionNodes(): ProtoWriter[] {
  const n: ProtoWriter[] = [
    constant("i0", int64([0])),
    constant("i1", int64([1])),
    constant("i2", int64([2])),
    constant("s0", int64([0], [])),
    constant("s1", int64([1], [])),
    constant("blk", int64([BLOCK])),
    constant("blk_s", int64([BLOCK], [])),
    constant("blk_m1", int64([BLOCK - 1])),
    constant("span", int64([SPAN], [])),
    constant("scale", float32([1 / Math.sqrt(64)], [])),
    constant("band", float32(bandMask(), [BLOCK, SPAN])),
    constant("zero_f", float32([0], [])),
    constant("neg_f", float32([NEG], [])),
    constant("neg1", int64([-1])),
    constant("big", { dims: [1], type: DATA_INT64, values: [2n ** 62n] }),
    node("Cast", ["q"], ["qf"], [{ name: "to", int: DATA_FLOAT }]),
    node("Cast", ["k"], ["kf"], [{ name: "to", int: DATA_FLOAT }]),
    node("Cast", ["v"], ["vf"], [{ name: "to", int: DATA_FLOAT }]),
    ...["q", "k", "v"].map((x) => node("Transpose", [`${x}f`], [`${x}t`], [{ name: "perm", ints: [0, 2, 1, 3] }])),
    node("Shape", ["qf"], ["shp"]),
    node("Gather", ["shp", "i0"], ["Bv"], [{ name: "axis", int: 0 }]),
    node("Gather", ["shp", "i1"], ["Nv"], [{ name: "axis", int: 0 }]),
    node("Gather", ["shp", "i2"], ["Cv"], [{ name: "axis", int: 0 }]),
    node(
      "Shape",
      ["qf"],
      ["Dv"],
      [
        { name: "start", int: 3 },
        { name: "end", int: 4 },
      ],
    ),
    node("Add", ["Nv", "blk_m1"], ["n_up"]),
    node("Div", ["n_up", "blk"], ["Gv"]),
    node("Mul", ["Gv", "blk"], ["Np"]),
    node("Sub", ["Np", "Nv"], ["padR"]),
    node("Add", ["padR", "blk"], ["padRk"]),
    node("Sub", ["i0", "i0"], ["i0z"]),
  ];
  const z = "i0z";
  n.push(
    node("Concat", [z, z, z, z, z, z, "padR", z], ["pads_q"], [{ name: "axis", int: 0 }]),
    node("Concat", [z, z, "blk", z, z, z, "padRk", z], ["pads_k"], [{ name: "axis", int: 0 }]),
    node("Pad", ["qt", "pads_q"], ["qp"]),
    node("Pad", ["kt", "pads_k"], ["kp"]),
    node("Pad", ["vt", "pads_k"], ["vp"]),
    node("Add", ["Gv", "i2"], ["G2"]),
    node("Concat", ["Bv", "Cv", "Gv", "blk", "Dv"], ["shape_q"], [{ name: "axis", int: 0 }]),
    node("Concat", ["Bv", "Cv", "G2", "blk", "Dv"], ["shape_k"], [{ name: "axis", int: 0 }]),
    node("Reshape", ["qp", "shape_q"], ["qg"]),
    node("Reshape", ["kp", "shape_k"], ["kg"]),
    node("Reshape", ["vp", "shape_k"], ["vg"]),
    node("Add", ["Gv", "i1"], ["G1"]),
  );
  for (const x of ["k", "v"]) {
    n.push(
      node("Slice", [`${x}g`, "i0", "Gv", "i2"], [`${x}0`]),
      node("Slice", [`${x}g`, "i1", "G1", "i2"], [`${x}1`]),
      node("Slice", [`${x}g`, "i2", "G2", "i2"], [`${x}2`]),
      node("Concat", [`${x}0`, `${x}1`, `${x}2`], [`${x}w`], [{ name: "axis", int: 3 }]),
    );
  }
  n.push(
    node("Transpose", ["kw"], ["kwT"], [{ name: "perm", ints: [0, 1, 2, 4, 3] }]),
    node("MatMul", ["qg", "kwT"], ["s_raw"]),
    node("Mul", ["s_raw", "scale"], ["s_sc"]),
    node("Squeeze", ["Gv", "i0"], ["G_s"]),
    node("Squeeze", ["Nv", "i0"], ["N_s"]),
    node("Range", ["s0", "G_s", "s1"], ["g_r"]),
    node("Range", ["s0", "span", "s1"], ["w_r"]),
    node("Mul", ["g_r", "blk_s"], ["g_off"]),
    node("Unsqueeze", ["g_off", "i1"], ["g_col"]),
    node("Unsqueeze", ["w_r", "i0"], ["w_row"]),
    node("Add", ["g_col", "w_row"], ["ppos"]),
    node("Add", ["N_s", "blk_s"], ["hi"]),
    node("GreaterOrEqual", ["ppos", "blk_s"], ["ok_lo"]),
    node("Less", ["ppos", "hi"], ["ok_hi"]),
    node("And", ["ok_lo", "ok_hi"], ["ok"]),
    node("Where", ["ok", "zero_f", "neg_f"], ["bnd"]),
    node("Unsqueeze", ["bnd", "i1"], ["bnd3"]),
    node("Add", ["bnd3", "band"], ["mask"]),
    node("Add", ["s_sc", "mask"], ["s_m"]),
    node("Softmax", ["s_m"], ["p"], [{ name: "axis", int: -1 }]),
    node("MatMul", ["p", "vw"], ["og"]),
    node("Concat", ["Bv", "Cv", "Np", "Dv"], ["shape_o"], [{ name: "axis", int: 0 }]),
    node("Reshape", ["og", "shape_o"], ["op"]),
    node("Slice", ["op", "i0", "Nv", "i2"], ["ot"]),
    node("Transpose", ["ot"], ["o"], [{ name: "perm", ints: [0, 2, 1, 3] }]),
    node("Div", ["Cv", "i2"], ["Hv"]),
    node("Slice", ["o", "i0", "Hv", "i2"], ["o1"]),
    node("Slice", ["o", "Hv", "big", "i2"], ["o2"]),
    node("Sub", ["o1", "o2"], ["diff"]),
    node("CastLike", ["diff", "q"], ["out"]),
  );
  return n;
}

/** The ModelProto bytes that define `samel.diff_attn_swa` in any file they are appended to. */
export function functionPatch(): Uint8Array {
  const fn = new ProtoWriter().string(1, "diff_attn_swa");
  for (const input of ["q", "k", "v"]) fn.string(4, input);
  fn.string(5, "out").string(6, "num_heads");
  for (const n of functionNodes()) fn.message(7, n);
  fn.message(9, new ProtoWriter().string(1, "").int(2, 17)).string(10, "samel");
  return new ProtoWriter().message(25, fn).finish();
}

/** The ModelProto bytes that add the decoder's float audio as a graph output. */
export function floatOutputPatch(): Uint8Array {
  const tensorType = new ProtoWriter().int(1, DATA_FLOAT);
  const valueInfo = new ProtoWriter()
    .string(1, DECODER_FLOAT_OUTPUT)
    .message(2, new ProtoWriter().message(1, tensorType));
  return new ProtoWriter().message(7, new ProtoWriter().message(12, valueInfo)).finish();
}
