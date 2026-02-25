import { clamp, imageDataToCanvas } from './utils.js';

function srgbToLinear(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v) {
  const x = clamp(v, 0, 1);
  const y = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(clamp(y * 255, 0, 255));
}

function fitRect(sw, sh, dw, dh, mode) {
  const scale = mode === 'fill' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return {
    x: (dw - w) / 2,
    y: (dh - h) / 2,
    w,
    h,
  };
}

export function composeBaseAndAlternate({
  baseBitmap,
  alternateBitmap,
  targetDisplay,
  imageScale,
  scaleMode,
  backgroundColor,
}) {
  const srcBaseW = baseBitmap?.width ?? alternateBitmap.width;
  const srcBaseH = baseBitmap?.height ?? alternateBitmap.height;
  const srcAltW = alternateBitmap.width;
  const srcAltH = alternateBitmap.height;

  const refW = targetDisplay === 'base' && baseBitmap ? srcBaseW : srcAltW;
  const refH = targetDisplay === 'base' && baseBitmap ? srcBaseH : srcAltH;

  const outW = Math.max(1, Math.round(refW * clamp(imageScale, 0.1, 1)));
  const outH = Math.max(1, Math.round(refH * clamp(imageScale, 0.1, 1)));

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = outW;
  baseCanvas.height = outH;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
  baseCtx.fillStyle = backgroundColor;
  baseCtx.fillRect(0, 0, outW, outH);

  if (baseBitmap) {
    const r = fitRect(srcBaseW, srcBaseH, outW, outH, scaleMode);
    baseCtx.drawImage(baseBitmap, r.x, r.y, r.w, r.h);
  }

  const altCanvas = document.createElement('canvas');
  altCanvas.width = outW;
  altCanvas.height = outH;
  const altCtx = altCanvas.getContext('2d', { willReadFrequently: true });
  altCtx.fillStyle = backgroundColor;
  altCtx.fillRect(0, 0, outW, outH);
  const rAlt = fitRect(srcAltW, srcAltH, outW, outH, scaleMode);
  altCtx.drawImage(alternateBitmap, rAlt.x, rAlt.y, rAlt.w, rAlt.h);

  return { baseCanvas, alternateCanvas: altCanvas, outW, outH };
}

export function buildGainMap({ baseCanvas, alternateCanvas, gamma = 1, offset = 1 }) {
  const width = baseCanvas.width;
  const height = baseCanvas.height;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
  const altCtx = alternateCanvas.getContext('2d', { willReadFrequently: true });
  const baseData = baseCtx.getImageData(0, 0, width, height);
  const altData = altCtx.getImageData(0, 0, width, height);

  const minBoost = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maxBoost = [0, 0, 0];
  const recovery = new Float32Array(width * height * 3);

  let idxRecovery = 0;
  for (let i = 0; i < baseData.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const bLin = srgbToLinear(baseData.data[i + c]);
      const aLin = srgbToLinear(altData.data[i + c]);
      const value = Math.max(0.000001, (aLin + offset) / (bLin + offset));
      recovery[idxRecovery++] = value;
      minBoost[c] = Math.min(minBoost[c], value);
      maxBoost[c] = Math.max(maxBoost[c], value);
    }
  }

  const gainMapData = new ImageData(width, height);
  idxRecovery = 0;
  for (let i = 0; i < gainMapData.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const minV = Math.max(minBoost[c], 0.000001);
      const maxV = Math.max(maxBoost[c], minV + 0.000001);
      const v = recovery[idxRecovery++];
      const t = clamp((Math.log(v) - Math.log(minV)) / (Math.log(maxV) - Math.log(minV)), 0, 1);
      gainMapData.data[i + c] = Math.round((t ** gamma) * 255);
    }
    gainMapData.data[i + 3] = 255;
  }

  return {
    gainMapCanvas: imageDataToCanvas(gainMapData),
    minContentBoost: minBoost,
    maxContentBoost: maxBoost,
  };
}

export function reconstructAlternateFromGainMap({ baseCanvas, gainMapCanvas, metadata }) {
  const width = baseCanvas.width;
  const height = baseCanvas.height;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
  const gainCtx = gainMapCanvas.getContext('2d', { willReadFrequently: true });

  const baseData = baseCtx.getImageData(0, 0, width, height);
  const gainData = gainCtx.getImageData(0, 0, width, height);
  const out = new ImageData(width, height);

  const gamma = metadata.gamma;
  const minBoost = metadata.minContentBoost;
  const maxBoost = metadata.maxContentBoost;
  const offsetSdr = metadata.offsetSdr;
  const offsetHdr = metadata.offsetHdr;

  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const g = gainData.data[i + c] / 255;
      const t = g ** (1 / gamma[c]);
      const minV = Math.max(minBoost[c], 0.000001);
      const maxV = Math.max(maxBoost[c], minV + 0.000001);
      const boost = Math.exp(Math.log(minV) + t * (Math.log(maxV) - Math.log(minV)));

      const bLin = srgbToLinear(baseData.data[i + c]);
      const aLin = boost * (bLin + offsetSdr[c]) - offsetHdr[c];
      out.data[i + c] = linearToSrgb(aLin);
    }
    out.data[i + 3] = 255;
  }

  return imageDataToCanvas(out);
}