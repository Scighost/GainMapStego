const ISO_NS = 'urn:iso:std:iso:ts:21496:-1';
const ISO_NS_Z = `${ISO_NS}\0`;
const FLAG_MULTI_CHANNEL = 1 << 7;
const FLAG_USE_BASE_COLOR_SPACE = 1 << 6;
const FLAG_BACKWARD_DIRECTION = 1 << 2;
const FLAG_USE_COMMON_DENOMINATOR = 1 << 3;
const MP_ENTRY_TYPE_PRIMARY = 0x00030000;
const MP_ENTRY_TYPE_GAINMAP = 0x00000000;

// ── ICC helpers ──────────────────────────────────────────────────────────────
// libultrahdr (encodeJPEGR API-4 / appendGainMap) always ensures the primary
// JPEG contains an ICC profile, and compressGainMap() also embeds ICC in the
// gainmap JPEG when running in ISO-only mode.  We mirror that behaviour here.

/**
 * Build a minimal valid ICC v2 sRGB display profile (310 bytes).
 * Structure: header(128) + tag_count(4) + tag_table(84) + rXYZ+gXYZ+bXYZ+wtpt(80) + shared_TRC(14)
 * sRGB primaries adapted to D50 illuminant per IEC 61966-2-1.
 */
function buildMinimalSrgbIccProfile() {
  // s15.16 fixed-point encoder (signed 15-bit integer + 16-bit fraction)
  const s15 = (v) => Math.round(v * 65536) | 0;

  // Profile memory layout
  const NUM_TAGS = 7;
  const TAG_TABLE_OFFSET = 132;               // 128 (header) + 4 (count)
  const TAG_DATA_OFFSET = TAG_TABLE_OFFSET + NUM_TAGS * 12; // = 216
  const TOTAL_SIZE = TAG_DATA_OFFSET + 4 * 20 + 14;         // = 310

  const buf = new Uint8Array(TOTAL_SIZE);

  const w32 = (o, v) => {
    v >>>= 0;
    buf[o] = (v >>> 24) & 0xff; buf[o + 1] = (v >>> 16) & 0xff;
    buf[o + 2] = (v >>> 8) & 0xff; buf[o + 3] = v & 0xff;
  };
  const w16 = (o, v) => { buf[o] = (v >> 8) & 0xff; buf[o + 1] = v & 0xff; };
  const wcc = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };

  // ── Header (128 bytes) ────────────────────────────────────────────────────
  w32(0, TOTAL_SIZE);          // profile size
  // CMM type:  0
  w32(8, 0x02100000);          // version 2.1.0.0
  wcc(12, 'mntr');             // profile class: display device
  wcc(16, 'RGB ');             // data colour space
  wcc(20, 'XYZ ');             // PCS
  // bytes 24-35: creation date/time (all zero)
  wcc(36, 'acsp');             // signature
  // bytes 40-63: platform, flags, device attribs (all zero)
  // bytes 64-67: rendering intent = 0 (perceptual)
  // PCS illuminant D50 XYZ in s15.16 at bytes 68-79
  w32(68, s15(0.9642029));
  w32(72, s15(1.0000000));
  w32(76, s15(0.8249054));
  // bytes 80-127: creator, profile ID, reserved (all zero)

  // ── Tag count ─────────────────────────────────────────────────────────────
  w32(128, NUM_TAGS);

  // ── Tag table (7 × 12 bytes) ──────────────────────────────────────────────
  const te = (i, sig, off, sz) => {
    const p = TAG_TABLE_OFFSET + i * 12;
    wcc(p, sig); w32(p + 4, off); w32(p + 8, sz);
  };
  te(0, 'rXYZ', TAG_DATA_OFFSET,      20); // rXYZ at 216
  te(1, 'gXYZ', TAG_DATA_OFFSET + 20, 20); // gXYZ at 236
  te(2, 'bXYZ', TAG_DATA_OFFSET + 40, 20); // bXYZ at 256
  te(3, 'wtpt', TAG_DATA_OFFSET + 60, 20); // wtpt at 276
  te(4, 'rTRC', TAG_DATA_OFFSET + 80, 14); // TRC at 296 (shared)
  te(5, 'gTRC', TAG_DATA_OFFSET + 80, 14);
  te(6, 'bTRC', TAG_DATA_OFFSET + 80, 14);

  // ── XYZ tag data helper (20 bytes: 'XYZ '+reserved+x+y+z) ────────────────
  const xyzTag = (off, x, y, z) => {
    wcc(off, 'XYZ ');      // type sig
    // 4 bytes reserved = 0 already
    w32(off + 8,  s15(x));
    w32(off + 12, s15(y));
    w32(off + 16, s15(z));
  };
  // sRGB primaries D50-adapted (IEC 61966-2-1)
  xyzTag(TAG_DATA_OFFSET,      0.4360748, 0.2225045, 0.0139322); // rXYZ
  xyzTag(TAG_DATA_OFFSET + 20, 0.3851462, 0.7168786, 0.0971045); // gXYZ
  xyzTag(TAG_DATA_OFFSET + 40, 0.1430805, 0.0606169, 0.7141733); // bXYZ
  xyzTag(TAG_DATA_OFFSET + 60, 0.9642029, 1.0000000, 0.8249054); // wtpt D50

  // ── Tone Reproduction Curve (curv, gamma ≈ 2.2, 14 bytes) ─────────────────
  const trcOff = TAG_DATA_OFFSET + 80;
  wcc(trcOff, 'curv');              // type sig
  // 4 bytes reserved = 0
  w32(trcOff + 8, 1);              // count = 1 (single gamma entry)
  w16(trcOff + 12, Math.round(2.2 * 256)); // gamma 2.2 as U8.8 = 0x0233

  return buf;
}

// Lazily-cached ICC profile bytes
let _srgbIcc = null;
function getSrgbIcc() {
  if (!_srgbIcc) _srgbIcc = buildMinimalSrgbIccProfile();
  return _srgbIcc;
}

/**
 * Return true if the JPEG already contains an ICC_PROFILE APP2 segment.
 * Browser canvas JPEG output often omits ICC, so we check before injecting.
 */
function jpegHasIcc(jpegBytes) {
  const ICC_SIG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"
  for (const seg of readJpegSegments(jpegBytes)) {
    if (seg.marker !== 0xe2 || seg.payload.length < 12) continue;
    let ok = true;
    for (let i = 0; i < 12; i++) { if (seg.payload[i] !== ICC_SIG[i]) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}

/**
 * Prepend an sRGB ICC_PROFILE APP2 segment right after the JPEG SOI marker,
 * matching the behaviour of libultrahdr's appendGainMap / compressGainMap.
 * If the JPEG already has ICC it is returned unchanged.
 */
function injectSrgbIccIfMissing(jpegBytes) {
  if (jpegHasIcc(jpegBytes)) return jpegBytes;
  const icc = getSrgbIcc();
  // JPEG ICC APP2 payload: "ICC_PROFILE\0" + seq(1) + total(1) + profile_bytes
  const iccPayload = concatBytes(
    new Uint8Array([0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]),
    new Uint8Array([0x01, 0x01]), // sequence 1 of 1
    icc,
  );
  const iccApp2 = createAppSegment(0xe2, iccPayload);
  // Insert after SOI (first 2 bytes)
  return concatBytes(jpegBytes.slice(0, 2), iccApp2, jpegBytes.slice(2));
}

export function createIsoMetadata({
  gamma,
  offsetSdr,
  offsetHdr,
  minContentBoost,
  maxContentBoost,
  hdrCapacityMin = 1,
  hdrCapacityMax = 2,
  useBaseColorSpace = 1,
}) {
  return {
    version: '1.0',
    namespace: ISO_NS,
    gamma,
    offsetSdr,
    offsetHdr,
    minContentBoost,
    maxContentBoost,
    hdrCapacityMin,
    hdrCapacityMax,
    useBaseColorSpace,
  };
}

function arr3(v) {
  return [Number(v?.[0] ?? 1), Number(v?.[1] ?? 1), Number(v?.[2] ?? 1)];
}

function allChannelsIdentical(v) {
  const a = arr3(v);
  return Math.abs(a[0] - a[1]) < 1e-9 && Math.abs(a[1] - a[2]) < 1e-9;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function writeU16BE(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeU8(bytes, offset, value) {
  bytes[offset] = value & 0xff;
}

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeS32BE(bytes, offset, value) {
  const u = value >>> 0;
  writeU32BE(bytes, offset, u);
}

function readU8(bytes, offset) {
  return bytes[offset];
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function readS32BE(bytes, offset) {
  const u = readU32BE(bytes, offset);
  return u > 0x7fffffff ? u - 0x100000000 : u;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function clampInt32(n) {
  return Math.max(-2147483648, Math.min(2147483647, n | 0));
}

function clampUInt32(n) {
  return Math.max(1, Math.min(0xffffffff, n >>> 0));
}

function floatToFractionCore(value, signed) {
  if (!Number.isFinite(value)) return null;
  const sign = value < 0 ? -1 : 1;
  if (!signed && sign < 0) return null;
  let x = Math.abs(value);
  if (x === 0) {
    return { n: 0, d: 1 };
  }

  const maxDen = 1000000;
  const maxNum = signed ? 2147483647 : 0xffffffff;

  let h1 = 1;
  let h0 = 0;
  let k1 = 0;
  let k0 = 1;
  let b = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen || h2 > maxNum) break;
    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    const frac = b - a;
    if (frac < 1e-12) break;
    b = 1 / frac;
  }

  let n = Math.round(h1) * sign;
  let d = Math.round(k1);
  if (d <= 0) d = 1;
  const g = gcd(n, d);
  n = Math.trunc(n / g);
  d = Math.trunc(d / g);

  if (signed) {
    if (Math.abs(n) > maxNum) return null;
    return { n: clampInt32(n), d: clampUInt32(d) };
  }
  if (n < 0 || n > maxNum) return null;
  return { n: n >>> 0, d: clampUInt32(d) };
}

function floatToSignedFraction(value) {
  return floatToFractionCore(value, true);
}

function floatToUnsignedFraction(value) {
  return floatToFractionCore(value, false);
}

function fractionToFloatSigned(n, d) {
  return Number(n) / Math.max(1, Number(d));
}

function fractionToFloatUnsigned(n, d) {
  return Number(n >>> 0) / Math.max(1, Number(d >>> 0));
}

function StreamWriter() {
  const data = [];
  return {
    writeU8(v) {
      data.push(v & 0xff);
    },
    writeU16(v) {
      data.push((v >> 8) & 0xff, v & 0xff);
    },
    writeU32(v) {
      data.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    },
    writeS32(v) {
      const u = v >>> 0;
      data.push((u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff);
    },
    toBytes() {
      return new Uint8Array(data);
    },
  };
}

function StreamReader(bytes) {
  let p = 0;
  return {
    remaining() {
      return bytes.length - p;
    },
    readU8() {
      if (p + 1 > bytes.length) throw new Error('metadata 截断(U8)');
      const v = readU8(bytes, p);
      p += 1;
      return v;
    },
    readU16() {
      if (p + 2 > bytes.length) throw new Error('metadata 截断(U16)');
      const v = readU16BE(bytes, p);
      p += 2;
      return v;
    },
    readU32() {
      if (p + 4 > bytes.length) throw new Error('metadata 截断(U32)');
      const v = readU32BE(bytes, p);
      p += 4;
      return v;
    },
    readS32() {
      if (p + 4 > bytes.length) throw new Error('metadata 截断(S32)');
      const v = readS32BE(bytes, p);
      p += 4;
      return v;
    },
  };
}

function createAppSegment(appMarker, payload) {
  const length = payload.length + 2;
  if (length > 0xffff) {
    throw new Error('APP 段过长，无法写入 JPEG');
  }
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = appMarker;
  writeU16BE(out, 2, length);
  out.set(payload, 4);
  return out;
}

function serializeIsoMetadataToBinary(metadata) {
  const gamma = arr3(metadata.gamma);
  const offsetSdr = arr3(metadata.offsetSdr);
  const offsetHdr = arr3(metadata.offsetHdr);
  const minBoost = arr3(metadata.minContentBoost);
  const maxBoost = arr3(metadata.maxContentBoost);

  const channelCount = 3;

  const gainMapMinN = [0, 0, 0];
  const gainMapMinD = [1, 1, 1];
  const gainMapMaxN = [0, 0, 0];
  const gainMapMaxD = [1, 1, 1];
  const gainMapGammaN = [1, 1, 1];
  const gainMapGammaD = [1, 1, 1];
  const baseOffsetN = [0, 0, 0];
  const baseOffsetD = [1, 1, 1];
  const alternateOffsetN = [0, 0, 0];
  const alternateOffsetD = [1, 1, 1];

  for (let i = 0; i < channelCount; i++) {
    const maxFrac = floatToSignedFraction(Math.log2(Math.max(maxBoost[i], 1e-12)));
    const minFrac = floatToSignedFraction(Math.log2(Math.max(minBoost[i], 1e-12)));
    const gammaFrac = floatToUnsignedFraction(gamma[i]);
    const baseOffFrac = floatToSignedFraction(offsetSdr[i]);
    const altOffFrac = floatToSignedFraction(offsetHdr[i]);
    if (!maxFrac || !minFrac || !gammaFrac || !baseOffFrac || !altOffFrac) {
      throw new Error('元数据浮点数无法转换为分数');
    }
    gainMapMaxN[i] = maxFrac.n;
    gainMapMaxD[i] = maxFrac.d;
    gainMapMinN[i] = minFrac.n;
    gainMapMinD[i] = minFrac.d;
    gainMapGammaN[i] = gammaFrac.n;
    gainMapGammaD[i] = gammaFrac.d;
    baseOffsetN[i] = baseOffFrac.n;
    baseOffsetD[i] = baseOffFrac.d;
    alternateOffsetN[i] = altOffFrac.n;
    alternateOffsetD[i] = altOffFrac.d;
  }

  const baseHdr = floatToUnsignedFraction(Math.log2(Math.max(Number(metadata.hdrCapacityMin ?? 1), 1e-12)));
  const alternateHdr = floatToUnsignedFraction(Math.log2(Math.max(Number(metadata.hdrCapacityMax ?? 1), 1e-12)));
  if (!baseHdr || !alternateHdr) {
    throw new Error('hdr capacity 无法转换为分数');
  }

  let useCommonDenominator = true;
  const commonDen = baseHdr.d;
  if (alternateHdr.d !== commonDen) useCommonDenominator = false;
  for (let c = 0; c < channelCount && useCommonDenominator; c++) {
    if (
      gainMapMinD[c] !== commonDen
      || gainMapMaxD[c] !== commonDen
      || gainMapGammaD[c] !== commonDen
      || baseOffsetD[c] !== commonDen
      || alternateOffsetD[c] !== commonDen
    ) {
      useCommonDenominator = false;
    }
  }

  // Always write 3-channel (multi-channel) gain map data.
  let flags = FLAG_MULTI_CHANNEL;
  if (Number(metadata.useBaseColorSpace ?? 1)) flags |= FLAG_USE_BASE_COLOR_SPACE;
  if (Number(metadata.backwardDirection ?? 0)) flags |= FLAG_BACKWARD_DIRECTION;
  if (useCommonDenominator) flags |= FLAG_USE_COMMON_DENOMINATOR;

  const writer = StreamWriter();
  writer.writeU16(0);
  writer.writeU16(0);
  writer.writeU8(flags);

  if (useCommonDenominator) {
    writer.writeU32(commonDen);
    writer.writeU32(baseHdr.n);
    writer.writeU32(alternateHdr.n);
    for (let c = 0; c < channelCount; c++) {
      writer.writeS32(gainMapMinN[c]);
      writer.writeS32(gainMapMaxN[c]);
      writer.writeU32(gainMapGammaN[c]);
      writer.writeS32(baseOffsetN[c]);
      writer.writeS32(alternateOffsetN[c]);
    }
  } else {
    writer.writeU32(baseHdr.n);
    writer.writeU32(baseHdr.d);
    writer.writeU32(alternateHdr.n);
    writer.writeU32(alternateHdr.d);
    for (let c = 0; c < channelCount; c++) {
      writer.writeS32(gainMapMinN[c]);
      writer.writeU32(gainMapMinD[c]);
      writer.writeS32(gainMapMaxN[c]);
      writer.writeU32(gainMapMaxD[c]);
      writer.writeU32(gainMapGammaN[c]);
      writer.writeU32(gainMapGammaD[c]);
      writer.writeS32(baseOffsetN[c]);
      writer.writeU32(baseOffsetD[c]);
      writer.writeS32(alternateOffsetN[c]);
      writer.writeU32(alternateOffsetD[c]);
    }
  }

  return writer.toBytes();
}

function parseIsoMetadataFromBinary(bytes) {
  const reader = StreamReader(bytes);
  reader.readU16();
  reader.readU16();
  const flags = reader.readU8();

  const isMultiChannel = (flags & FLAG_MULTI_CHANNEL) !== 0;
  const useBaseColorSpace = (flags & FLAG_USE_BASE_COLOR_SPACE) !== 0;
  const useCommonDenominator = (flags & FLAG_USE_COMMON_DENOMINATOR) !== 0;
  const channelCount = isMultiChannel ? 3 : 1;

  const gainMapMinN = [0, 0, 0];
  const gainMapMinD = [1, 1, 1];
  const gainMapMaxN = [0, 0, 0];
  const gainMapMaxD = [1, 1, 1];
  const gainMapGammaN = [1, 1, 1];
  const gainMapGammaD = [1, 1, 1];
  const baseOffsetN = [0, 0, 0];
  const baseOffsetD = [1, 1, 1];
  const alternateOffsetN = [0, 0, 0];
  const alternateOffsetD = [1, 1, 1];

  let baseHdrN;
  let baseHdrD;
  let alternateHdrN;
  let alternateHdrD;

  if (useCommonDenominator) {
    const den = reader.readU32();
    baseHdrN = reader.readU32();
    baseHdrD = den;
    alternateHdrN = reader.readU32();
    alternateHdrD = den;
    for (let c = 0; c < channelCount; c++) {
      gainMapMinN[c] = reader.readS32();
      gainMapMinD[c] = den;
      gainMapMaxN[c] = reader.readS32();
      gainMapMaxD[c] = den;
      gainMapGammaN[c] = reader.readU32();
      gainMapGammaD[c] = den;
      baseOffsetN[c] = reader.readS32();
      baseOffsetD[c] = den;
      alternateOffsetN[c] = reader.readS32();
      alternateOffsetD[c] = den;
    }
  } else {
    baseHdrN = reader.readU32();
    baseHdrD = reader.readU32();
    alternateHdrN = reader.readU32();
    alternateHdrD = reader.readU32();
    for (let c = 0; c < channelCount; c++) {
      gainMapMinN[c] = reader.readS32();
      gainMapMinD[c] = reader.readU32();
      gainMapMaxN[c] = reader.readS32();
      gainMapMaxD[c] = reader.readU32();
      gainMapGammaN[c] = reader.readU32();
      gainMapGammaD[c] = reader.readU32();
      baseOffsetN[c] = reader.readS32();
      baseOffsetD[c] = reader.readU32();
      alternateOffsetN[c] = reader.readS32();
      alternateOffsetD[c] = reader.readU32();
    }
  }

  if (channelCount === 1) {
    for (let i = 1; i < 3; i++) {
      gainMapMinN[i] = gainMapMinN[0];
      gainMapMinD[i] = gainMapMinD[0];
      gainMapMaxN[i] = gainMapMaxN[0];
      gainMapMaxD[i] = gainMapMaxD[0];
      gainMapGammaN[i] = gainMapGammaN[0];
      gainMapGammaD[i] = gainMapGammaD[0];
      baseOffsetN[i] = baseOffsetN[0];
      baseOffsetD[i] = baseOffsetD[0];
      alternateOffsetN[i] = alternateOffsetN[0];
      alternateOffsetD[i] = alternateOffsetD[0];
    }
  }

  return createIsoMetadata({
    gamma: gainMapGammaN.map((n, i) => fractionToFloatUnsigned(n, gainMapGammaD[i])),
    offsetSdr: baseOffsetN.map((n, i) => fractionToFloatSigned(n, baseOffsetD[i])),
    offsetHdr: alternateOffsetN.map((n, i) => fractionToFloatSigned(n, alternateOffsetD[i])),
    minContentBoost: gainMapMinN.map((n, i) => Math.pow(2, fractionToFloatSigned(n, gainMapMinD[i]))),
    maxContentBoost: gainMapMaxN.map((n, i) => Math.pow(2, fractionToFloatSigned(n, gainMapMaxD[i]))),
    hdrCapacityMin: Math.pow(2, fractionToFloatUnsigned(baseHdrN, baseHdrD)),
    hdrCapacityMax: Math.pow(2, fractionToFloatUnsigned(alternateHdrN, alternateHdrD)),
    useBaseColorSpace: useBaseColorSpace ? 1 : 0,
  });
}

function buildMpfPayload(primaryLength, secondaryLength, secondaryOffset) {
  const entryCount = 3;
  const imageCount = 2;
  const mpfSig = new Uint8Array([0x4d, 0x50, 0x46, 0x00]);
  const tiff = new Uint8Array(86 - 4);

  tiff[0] = 0x4d;
  tiff[1] = 0x4d;
  tiff[2] = 0x00;
  tiff[3] = 0x2a;
  writeU32BE(tiff, 4, 8);

  let p = 8;
  writeU16BE(tiff, p, entryCount);
  p += 2;

  const writeIfdEntry = (tag, type, count, valueOrOffset) => {
    writeU16BE(tiff, p, tag);
    writeU16BE(tiff, p + 2, type);
    writeU32BE(tiff, p + 4, count);
    writeU32BE(tiff, p + 8, valueOrOffset);
    p += 12;
  };

  writeIfdEntry(0xb000, 7, 4, 0x30313030);
  writeIfdEntry(0xb001, 4, 1, imageCount);
  writeIfdEntry(0xb002, 7, imageCount * 16, 50);

  writeU32BE(tiff, p, 0);
  p += 4;

  writeU32BE(tiff, p, MP_ENTRY_TYPE_PRIMARY);
  writeU32BE(tiff, p + 4, primaryLength);
  writeU32BE(tiff, p + 8, 0);
  writeU16BE(tiff, p + 12, 0);
  writeU16BE(tiff, p + 14, 0);
  p += 16;

  writeU32BE(tiff, p, MP_ENTRY_TYPE_GAINMAP);
  writeU32BE(tiff, p + 4, secondaryLength);
  writeU32BE(tiff, p + 8, secondaryOffset);
  writeU16BE(tiff, p + 12, 0);
  writeU16BE(tiff, p + 14, 0);

  return concatBytes(mpfSig, tiff);
}

function readJpegSegments(jpegBytes) {
  const segments = [];
  if (jpegBytes.length < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    return segments;
  }
  let p = 2;
  while (p + 3 < jpegBytes.length) {
    if (jpegBytes[p] !== 0xff) {
      p += 1;
      continue;
    }
    const markerStart = p;
    while (p < jpegBytes.length && jpegBytes[p] === 0xff) p += 1;
    if (p >= jpegBytes.length) break;
    const marker = jpegBytes[p];
    p += 1;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xda) {
      break;
    }
    if (p + 1 >= jpegBytes.length) break;
    const length = readU16BE(jpegBytes, p);
    const payloadStart = p + 2;
    const payloadEnd = p + length;
    if (payloadEnd > jpegBytes.length || length < 2) break;
    segments.push({ marker, markerStart, payloadStart, payloadEnd, payload: jpegBytes.slice(payloadStart, payloadEnd) });
    p = payloadEnd;
  }
  return segments;
}

function parseMpf(payload) {
  if (payload.length < 8 || payload[0] !== 0x4d || payload[1] !== 0x50 || payload[2] !== 0x46 || payload[3] !== 0x00) {
    return null;
  }
  const tiff = payload.slice(4);
  if (tiff.length < 8 || tiff[0] !== 0x4d || tiff[1] !== 0x4d) {
    return null;
  }

  const ifd0Offset = readU32BE(tiff, 4);
  if (ifd0Offset + 2 > tiff.length) return null;
  const count = readU16BE(tiff, ifd0Offset);
  let p = ifd0Offset + 2;

  let imageCount = 0;
  let mpEntryOffset = 0;
  for (let i = 0; i < count; i++) {
    if (p + 12 > tiff.length) return null;
    const tag = readU16BE(tiff, p);
    const valueOrOffset = readU32BE(tiff, p + 8);
    if (tag === 0xb001) imageCount = valueOrOffset;
    if (tag === 0xb002) mpEntryOffset = valueOrOffset;
    p += 12;
  }

  if (imageCount < 2 || mpEntryOffset <= 0) return null;

  const candidateOffsets = [
    mpEntryOffset,
    mpEntryOffset + 4,
    Math.max(0, tiff.length - imageCount * 16),
  ];

  for (const base of candidateOffsets) {
    const entries = [];
    let valid = true;
    for (let i = 0; i < imageCount; i++) {
      const e = base + i * 16;
      if (e + 16 > tiff.length) {
        valid = false;
        break;
      }
      const size = readU32BE(tiff, e + 4);
      const offset = readU32BE(tiff, e + 8);
      entries.push({ size, offset });
    }
    if (!valid) continue;
    if (entries[0].size > 0 && entries[1].size > 0) {
      return entries;
    }
  }

  return null;
}

function findFirstEoi(bytes) {
  // JPEG-aware EOI finder: walks marker segments to avoid false FF D9
  // matches inside APP/DQT/DHT/COM/etc. payloads.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return -1;
  let p = 2;
  while (p + 1 < bytes.length) {
    // skip padding FF bytes
    if (bytes[p] !== 0xff) { p++; continue; }
    while (p + 1 < bytes.length && bytes[p + 1] === 0xff) p++;
    if (p + 1 >= bytes.length) break;
    const marker = bytes[p + 1];
    p += 2;
    if (marker === 0xd9) return p;                                          // EOI
    if (marker === 0xd8 || marker === 0x01
        || (marker >= 0xd0 && marker <= 0xd7)) continue;                    // SOI / standalone
    if (marker === 0xda) {                                                   // SOS
      if (p + 1 >= bytes.length) break;
      const sosLen = readU16BE(bytes, p);
      p += sosLen;                                                           // skip SOS header
      while (p + 1 < bytes.length) {                                        // scan entropy data
        if (bytes[p] !== 0xff) { p++; continue; }
        if (bytes[p + 1] === 0x00) { p += 2; continue; }                    // byte stuffing
        if (bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7) { p += 2; continue; } // RST
        break;                                                               // real marker
      }
      continue;
    }
    if (p + 1 >= bytes.length) break;
    const len = readU16BE(bytes, p);
    if (len < 2) break;
    p += len;
  }
  // fallback: naive backward scan
  for (let i = bytes.length - 2; i >= 2; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2;
  }
  return -1;
}

function findSecondSoiAfter(bytes, start) {
  for (let i = Math.max(0, start); i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) return i;
  }
  return -1;
}

function findEoiAfter(bytes, start) {
  for (let i = Math.max(0, start); i < bytes.length - 1; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2;
  }
  return -1;
}

function parseIsoApp2Payload(payload) {
  const nsWithNull = new TextEncoder().encode(ISO_NS_Z);
  const nsWithoutNull = new TextEncoder().encode(ISO_NS);

  let offset = -1;
  if (payload.length >= nsWithNull.length) {
    let ok = true;
    for (let i = 0; i < nsWithNull.length; i++) {
      if (payload[i] !== nsWithNull[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      offset = nsWithNull.length;
    }
  }

  if (offset < 0 && payload.length >= nsWithoutNull.length) {
    let ok = true;
    for (let i = 0; i < nsWithoutNull.length; i++) {
      if (payload[i] !== nsWithoutNull[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      offset = nsWithoutNull.length;
      if (payload.length > offset && payload[offset] === 0) {
        offset += 1;
      }
    }
  }

  if (offset < 0) return null;
  const body = payload.slice(offset);
  if (body.length === 4) {
    return { kind: 'version', minimumVersion: (body[0] << 8) | body[1], writerVersion: (body[2] << 8) | body[3] };
  }
  return { kind: 'metadata', body };
}

function splitLeadingAppSegments(jpegBodyWithoutSoi) {
  let p = 0;
  while (p + 4 <= jpegBodyWithoutSoi.length) {
    if (jpegBodyWithoutSoi[p] !== 0xff) break;
    let q = p + 1;
    while (q < jpegBodyWithoutSoi.length && jpegBodyWithoutSoi[q] === 0xff) q += 1;
    if (q >= jpegBodyWithoutSoi.length) break;
    const marker = jpegBodyWithoutSoi[q];
    if (marker < 0xe0 || marker > 0xef) break;
    if (q + 2 >= jpegBodyWithoutSoi.length) break;
    const len = readU16BE(jpegBodyWithoutSoi, q + 1);
    if (len < 2) break;
    const segEnd = q + 1 + len;
    if (segEnd > jpegBodyWithoutSoi.length) break;
    p = segEnd;
  }
  return {
    appPrefix: jpegBodyWithoutSoi.slice(0, p),
    rest: jpegBodyWithoutSoi.slice(p),
  };
}

function extractIsoMetadataFromJpeg(jpegBytes) {
  for (const seg of readJpegSegments(jpegBytes)) {
    if (seg.marker !== 0xe2) continue;
    const iso = parseIsoApp2Payload(seg.payload);
    if (iso?.kind === 'metadata') {
      try {
        return parseIsoMetadataFromBinary(iso.body);
      } catch {
      }
    }
  }
  return null;
}

export function packGainmapJpeg({ baseJpegBytes, gainmapJpegBytes, metadata }) {
  if (baseJpegBytes[0] !== 0xff || baseJpegBytes[1] !== 0xd8) {
    throw new Error('表图不是 JPEG');
  }
  if (gainmapJpegBytes[0] !== 0xff || gainmapJpegBytes[1] !== 0xd8) {
    throw new Error('增益图不是 JPEG');
  }

  // ── ICC / use_base_cg logic (mirrors libultrahdr encodeJPEGR API-4) ─────────
  // 1. Primary JPEG must always carry an ICC profile so Android can read the
  //    colour gamut. Inject a minimal sRGB ICC when the browser canvas omits it.
  const baseJpegWithIcc = injectSrgbIccIfMissing(baseJpegBytes);

  // 2. Gainmap ICC governs the use_base_cg (FLAG_USE_BASE_COLOR_SPACE) flag:
  //    - No ICC in gainmap  → gainmap shares the primary's colour space
  //                           → use_base_cg = true  (decoder must NOT look for
  //                             gainmap ICC; libultrahdr will reject the file if
  //                             use_base_cg=false but gainmap has no ICC)
  //    - ICC present        → gainmap carries its own alternate-image colour space
  //                           → use_base_cg = false, ICC is preserved as-is
  const gainmapHasIcc = jpegHasIcc(gainmapJpegBytes);
  const effectiveMeta = { ...metadata, useBaseColorSpace: gainmapHasIcc ? 0 : 1 };

  const isoNs = new TextEncoder().encode(ISO_NS_Z);

  // ---- secondary image segments ----
  const isoSecondaryData = serializeIsoMetadataToBinary(effectiveMeta);
  const secondaryIso = createAppSegment(0xe2, concatBytes(isoNs, isoSecondaryData));

  const baseBody    = baseJpegWithIcc.slice(2);  // everything after SOI
  const gainmapBody = gainmapJpegBytes.slice(2); // everything after SOI (ICC kept as-is)

  // secondary image total size = SOI + ISO APP2 + gainmap body
  const secondaryImageSize = 2 + secondaryIso.length + gainmapBody.length;

  // ---- primary image segments ----
  const primaryIsoVersion = createAppSegment(0xe2, concatBytes(isoNs, new Uint8Array([0, 0, 0, 0])));

  // position in file just before the MPF APP2 segment
  const posBeforeMpf = 2 + primaryIsoVersion.length;

  // MPF segment total size = marker(2) + length(2) + payload
  const mpfPayload = buildMpfPayload(0, secondaryImageSize, 0);
  const mpfSegmentSize = 4 + mpfPayload.length;

  const primaryImageSize = posBeforeMpf + mpfSegmentSize + baseBody.length;
  // secondary offset is relative to TIFF header (MM bytes) inside the MPF APP2,
  // which starts 8 bytes after the MPF segment marker (FF E2 + length(2) + "MPF\0"(4))
  const secondaryOffset = primaryImageSize - posBeforeMpf - 8;

  const mpf = createAppSegment(0xe2, buildMpfPayload(primaryImageSize, secondaryImageSize, secondaryOffset));

  // primary: SOI → ISO(version) → MPF → base body
  const primary = concatBytes(
    new Uint8Array([0xff, 0xd8]),
    primaryIsoVersion,
    mpf,
    baseBody,
  );
  // secondary: SOI → ISO(full metadata) → gainmap body
  const secondary = concatBytes(
    new Uint8Array([0xff, 0xd8]),
    secondaryIso,
    gainmapBody,
  );
  return concatBytes(primary, secondary);
}

export function unpackGainmapJpeg(bytes) {
  const baseEnd = findFirstEoi(bytes);
  if (baseEnd < 4) {
    throw new Error('不是合法的增益图 JPG');
  }
  const baseJpegBytes = bytes.slice(0, baseEnd);

  let secondaryStart = findSecondSoiAfter(bytes, baseEnd);
  let secondarySize = 0;
  if (secondaryStart <= 0) {
    for (const seg of readJpegSegments(baseJpegBytes)) {
      if (seg.marker !== 0xe2) continue;
      const entries = parseMpf(seg.payload);
      if (!entries || entries.length < 2) continue;
      const mpfOffset = entries[1].offset;
      const tiffStart = seg.payloadStart + 4;
      const candidates = [mpfOffset, tiffStart + mpfOffset, seg.markerStart + mpfOffset];
      const uniqueCandidates = [...new Set(candidates)].filter((v) => v >= 0 && v + 1 < bytes.length);
      for (const c of uniqueCandidates) {
        if (bytes[c] === 0xff && bytes[c + 1] === 0xd8) {
          secondaryStart = c;
          secondarySize = entries[1].size;
          break;
        }
      }
      if (secondaryStart > 0) break;
    }
  }
  if (secondaryStart <= 0 || secondaryStart + 2 > bytes.length) {
    throw new Error('未找到副图（gainmap）');
  }

  const secondaryEnd = findEoiAfter(bytes, secondaryStart + 2);
  const gainmapJpegBytes = secondaryEnd > secondaryStart
    ? bytes.slice(secondaryStart, secondaryEnd)
    : (secondarySize > 0 && secondaryStart + secondarySize <= bytes.length
      ? bytes.slice(secondaryStart, secondaryStart + secondarySize)
      : bytes.slice(secondaryStart));

  let parsedMetadata = extractIsoMetadataFromJpeg(gainmapJpegBytes);
  if (!parsedMetadata) {
    parsedMetadata = extractIsoMetadataFromJpeg(bytes.slice(secondaryStart));
  }
  if (!parsedMetadata) {
    parsedMetadata = extractIsoMetadataFromJpeg(baseJpegBytes);
  }
  if (!parsedMetadata) {
    throw new Error('未找到 ISO 21496-1 metadata（已尝试副图 APP2/回退扫描）');
  }

  return {
    metadata: parsedMetadata,
    baseJpegBytes,
    gainmapJpegBytes,
  };
}