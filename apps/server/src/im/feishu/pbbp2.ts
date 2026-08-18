// 飞书长连接 PB-BP2 协议编解码（T2 #57；spec #55 决策 2）。与官方 larksuite/oapi-sdk-* ws 模块同契约（pbbp2.proto）：
//
//   message Header { required string key = 1; required string value = 2; }
//   message Frame {
//     required uint64 SeqID = 1;        // 会话内序号
//     required uint64 LogID = 2;
//     required int32  service = 3;      // 服务 id（控制帧心跳用）
//     required int32  method  = 4;      // 0=control(ping/pong)  1=data(事件)
//     repeated Header  headers = 5;     // type/message_id/sum/seq/trace_id/biz_rt
//     optional string payload_encoding = 6;
//     optional string payload_type     = 7;
//     optional bytes  payload = 8;      // 事件 JSON
//     optional string LogIDNew = 9;
//   }
//
// 本文件是生产 client 与假飞书（test/fake-feishu.ts）共享的 codec——CI 里走的正是真 wire 字节
// （不再 mock 帧格式），配合 golden-bytes 单测兜住「对称编码 bug」。只实现 Frame/Header 两层，
// 手写 protobuf varint + length-delimited（不引入 protobuf 依赖，KISS）。
export const PBBP2_CONTROL = 0; // frame.method: 心跳/控制
export const PBBP2_DATA = 1;    // frame.method: 数据（事件）

// headers key 常量（与官方 ws/const.py 一致）
export const HDR_TYPE = "type";
export const HDR_MESSAGE_ID = "message_id";
export const HDR_SUM = "sum";
export const HDR_SEQ = "seq";
export const HDR_TRACE_ID = "trace_id";
export const HDR_BIZ_RT = "biz_rt";

// header type 取值（与官方 ws/enum.py MessageType 一致）
export const MSG_TYPE_EVENT = "event";
export const MSG_TYPE_CARD = "card";
export const MSG_TYPE_PING = "ping";
export const MSG_TYPE_PONG = "pong";

export interface Pbbp2Header {
  key: string;
  value: string;
}

export interface Pbbp2Frame {
  seqId: number;
  logId: number;
  service: number;
  method: number;
  headers: Pbbp2Header[];
  payloadEncoding?: string;
  payloadType?: string;
  /** 无 payload = 空 Uint8Array（proto2 optional bytes 未设置与空区分不了，调用方按需解释）。 */
  payload: Uint8Array;
  logIdNew?: string;
}

const TE = new TextEncoder();
const TD = new TextDecoder();

export function headerValue(headers: Pbbp2Header[], key: string): string | undefined {
  return headers.find((h) => h.key === key)?.value;
}

/** WS 消息 → Uint8Array（文本帧/非二进制 → null）。ArrayBuffer/Buffer/ArrayBufferView 通吃（Bun 各版本消息形态不一）。
 *  注意不能 `new Uint8Array(view)`——TS 的 Uint8Array 构造没有 ArrayBufferView 过载，须经 buffer+offset 取视图。 */
export function toUint8Array(raw: unknown): Uint8Array | null {
  if (typeof raw === "string") return null;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    return new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength);
  }
  return null;
}

function writeVarint(out: number[], v: number): void {
  // proto2 的 uint64/int32 都走 varint；长连接帧的值都很小，直接数位累加。
  if (v < 0) v = v >>> 0; // int32 负值 → 无符号（方法/服务号不应为负；防御性处理）
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function readVarint(b: Uint8Array, pos: { i: number }): number {
  let v = 0;
  let shift = 0;
  let c: number;
  do {
    c = b[pos.i++];
    if (pos.i > b.length + 1) throw new Error("pbbp2: varint 越界");
    v += (c & 0x7f) * 2 ** shift;
    shift += 7;
  } while (c & 0x80);
  return v;
}

function pushTag(out: number[], fieldNo: number, wireType: number): void {
  writeVarint(out, (fieldNo << 3) | wireType);
}

function pushVarintField(out: number[], fieldNo: number, v: number): void {
  pushTag(out, fieldNo, 0);
  writeVarint(out, v);
}

function pushBytesField(out: number[], fieldNo: number, b: Uint8Array): void {
  pushTag(out, fieldNo, 2);
  writeVarint(out, b.length);
  for (const x of b) out.push(x);
}

function pushStringField(out: number[], fieldNo: number, s: string): void {
  pushBytesField(out, fieldNo, TE.encode(s));
}

function encodeHeaderBytes(h: Pbbp2Header): number[] {
  const out: number[] = [];
  pushStringField(out, 1, h.key); // key = 1（required string）
  pushStringField(out, 2, h.value); // value = 2（required string）
  return out;
}

/** 编码一层 Frame。字段顺序与 proto2 声明的规范序一致（序列化器不要求，但一致更稳）。 */
export function encodeFrame(f: Pbbp2Frame): Uint8Array {
  const out: number[] = [];
  pushVarintField(out, 1, f.seqId); // SeqID = 1 (uint64)
  pushVarintField(out, 2, f.logId); // LogID = 2 (uint64)
  pushVarintField(out, 3, f.service); // service = 3 (int32)
  pushVarintField(out, 4, f.method); // method = 4 (int32)
  for (const h of f.headers) {
    const hb = encodeHeaderBytes(h);
    pushTag(out, 5, 2); // headers = 5（repeated embedded message）
    writeVarint(out, hb.length);
    for (const x of hb) out.push(x);
  }
  if (f.payloadEncoding !== undefined) pushStringField(out, 6, f.payloadEncoding);
  if (f.payloadType !== undefined) pushStringField(out, 7, f.payloadType);
  if (f.payload.length > 0) pushBytesField(out, 8, f.payload); // payload = 8 (bytes)
  if (f.logIdNew !== undefined) pushStringField(out, 9, f.logIdNew);
  return Uint8Array.from(out);
}

function readVarintField(bytes: Uint8Array, pos: { i: number }): { v: number } {
  return { v: readVarint(bytes, pos) };
}

function readLenDelim(bytes: Uint8Array, pos: { i: number }): Uint8Array {
  const len = readVarint(bytes, pos);
  const start = pos.i;
  pos.i += len;
  if (pos.i > bytes.length) throw new Error("pbbp2: length-delimited 越界");
  return bytes.slice(start, pos.i);
}

/** 解码一层 Frame（proto2：未知字段跳过；必需字段缺失给默认值，日志层兜）。 */
export function decodeFrame(data: Uint8Array): Pbbp2Frame {
  const pos = { i: 0 };
  const f: Pbbp2Frame = { seqId: 0, logId: 0, service: 0, method: -1, headers: [], payload: new Uint8Array() };
  while (pos.i < data.length) {
    const tag = readVarint(data, pos);
    const fieldNo = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const { v } = readVarintField(data, pos);
      switch (fieldNo) {
        case 1: f.seqId = v; break;
        case 2: f.logId = v; break;
        case 3: f.service = v; break;
        case 4: f.method = v; break;
      }
    } else if (wireType === 2) {
      const b = readLenDelim(data, pos);
      switch (fieldNo) {
        case 5: f.headers.push(decodeHeaderBytes(b)); break;
        case 6: f.payloadEncoding = TD.decode(b); break;
        case 7: f.payloadType = TD.decode(b); break;
        case 8: f.payload = b; break;
        case 9: f.logIdNew = TD.decode(b); break;
      }
    } else {
      throw new Error(`pbbp2: 不支持 wireType=${wireType} (field ${fieldNo})`);
    }
  }
  return f;
}

function decodeHeaderBytes(b: Uint8Array): Pbbp2Header {
  const pos = { i: 0 };
  const h: Pbbp2Header = { key: "", value: "" };
  while (pos.i < b.length) {
    const tag = readVarint(b, pos);
    const fieldNo = tag >> 3;
    const wireType = tag & 7;
    if (wireType !== 2) throw new Error("pbbp2: Header 字段非 length-delimited");
    const s = TD.decode(readLenDelim(b, pos));
    if (fieldNo === 1) h.key = s;
    else if (fieldNo === 2) h.value = s;
  }
  return h;
}