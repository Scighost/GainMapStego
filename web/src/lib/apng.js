/**
 * APNG 打包（纯 JS，无依赖）。
 *
 * 把逐帧 PNG 字节组装为单文件动画 PNG：
 *   - 第 1 帧写入 IDAT，同时作为静态默认图 —— 不识别 APNG 的查看器
 *     只会显示第 1 帧（表图）；
 *   - 其余帧写入 fdAT，由 acTL/fcTL 描述播放参数；
 *   - num_plays 固定为 1（只播放一遍），播完停在最后一帧。
 *
 * 分块布局（长度/序号均大端，CRC 按 PNG 规范对 type+data 计算）：
 *   PNG 签名 + 第 1 帧的 IHDR 及前置分块 + acTL + fcTL(seq=0) + IDAT +
 *   fcTL(seq=1) + fdAT(seq=2…) + … + IEND
 * fcTL 与 fdAT 共享序列号空间；IDAT 不占序列号。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ── CRC32（PNG 多项式 0xEDB88320） ─────────────────────────────────────────
let _crcTable = null;
function getCrcTable() {
  if (_crcTable) return _crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  _crcTable = table;
  return table;
}

function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 大端读写 ────────────────────────────────────────────────────────────────
function writeU32(bytes, off, v) {
  bytes[off] = (v >>> 24) & 0xff;
  bytes[off + 1] = (v >>> 16) & 0xff;
  bytes[off + 2] = (v >>> 8) & 0xff;
  bytes[off + 3] = v & 0xff;
}

function readU32(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

/** 组装一个 PNG 分块：length + type + data + CRC(type+data) */
function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 解析 PNG 为分块列表；raw 保留原始字节（含 CRC），可直接复制输出 */
function parsePngChunks(bytes) {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('APNG 帧不是合法的 PNG');
  }
  const chunks = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const length = readU32(bytes, off);
    if (off + 12 + length > bytes.length) {
      throw new Error('PNG 分块数据不完整');
    }
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    chunks.push({
      type,
      data: bytes.subarray(off + 8, off + 8 + length),
      raw: bytes.subarray(off, off + 12 + length),
    });
    off += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function chunksEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** acTL：num_frames + num_plays（0 = 无限循环，此处固定 1 = 只播放一遍） */
function makeActl(numFrames, numPlays) {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setUint32(0, numFrames);
  view.setUint32(4, numPlays);
  return makeChunk('acTL', data);
}

/**
 * fcTL：帧控制块（26 字节）。
 * 全幅帧（offset=0）、dispose_op=0 (NONE)、blend_op=0 (SOURCE)：
 * 每帧完整覆盖前帧，适合表图↔里图这种整幅切换。
 */
function makeFctl(seq, width, height, delayMs) {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint32(0, seq);            // sequence_number
  view.setUint32(4, width);
  view.setUint32(8, height);
  view.setUint32(12, 0);             // x_offset
  view.setUint32(16, 0);             // y_offset
  view.setUint16(20, delayMs);       // delay_num
  view.setUint16(22, 1000);          // delay_den → 延迟秒数 = delayMs / 1000
  data[24] = 0;                      // dispose_op: NONE
  data[25] = 0;                      // blend_op: SOURCE
  return makeChunk('fcTL', data);
}

/**
 * 组装 APNG：帧的 PNG 编码由调用方完成（浏览器原生 canvas → PNG）。
 * @param {Uint8Array[]} pngBytesList 每帧的 PNG 字节，第 1 帧同时作为默认图
 * @param {number} [delayMs] 每帧停留毫秒数
 * @returns {Uint8Array}
 */
export function assembleApng(pngBytesList, delayMs = 1000) {
  if (!pngBytesList || pngBytesList.length < 2) {
    throw new Error('APNG 至少需要两帧');
  }
  const delay = Math.min(65535, Math.max(1, Math.round(delayMs)));
  const pngs = pngBytesList;
  const chunkLists = pngs.map(parsePngChunks);

  // 所有帧必须共用同一 IHDR（尺寸、位深、颜色类型……）
  const ihdrs = chunkLists.map((chunks) => chunks.find((c) => c.type === 'IHDR'));
  if (ihdrs.some((ihdr) => !ihdr)) {
    throw new Error('PNG 缺少 IHDR 分块');
  }
  for (let i = 1; i < ihdrs.length; i++) {
    if (!chunksEqual(ihdrs[0].data, ihdrs[i].data)) {
      throw new Error('APNG 各帧的尺寸或格式不一致');
    }
  }
  const width = readU32(ihdrs[0].data, 0);
  const height = readU32(ihdrs[0].data, 4);

  // 输出片段列表，最后一次性合并，避免中间拷贝
  const parts = [new Uint8Array(PNG_SIGNATURE)];

  // 第 1 帧：IHDR 及 IDAT 之前的分块（sRGB 等）原样保留
  const firstChunks = chunkLists[0];
  const firstIdatIndex = firstChunks.findIndex((c) => c.type === 'IDAT');
  if (firstIdatIndex < 0) {
    throw new Error('PNG 缺少 IDAT 分块');
  }
  for (let i = 0; i < firstIdatIndex; i++) {
    parts.push(firstChunks[i].raw);
  }

  // acTL + 第 1 帧 fcTL 须位于 IDAT 之前
  parts.push(makeActl(pngs.length, 1));
  parts.push(makeFctl(0, width, height, delay));
  for (let i = firstIdatIndex; i < firstChunks.length; i++) {
    if (firstChunks[i].type === 'IDAT') parts.push(firstChunks[i].raw);
  }

  // 后续帧：fcTL + fdAT（data = 4 字节序列号 + 该帧 IDAT 数据）
  let seq = 1;
  for (let f = 1; f < pngs.length; f++) {
    parts.push(makeFctl(seq++, width, height, delay));
    for (const chunk of chunkLists[f]) {
      if (chunk.type !== 'IDAT') continue;
      const fdData = new Uint8Array(4 + chunk.data.length);
      writeU32(fdData, 0, seq++);
      fdData.set(chunk.data, 4);
      parts.push(makeChunk('fdAT', fdData));
    }
  }

  parts.push(makeChunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
