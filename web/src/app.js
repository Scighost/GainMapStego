import { buildGainMap, composeBaseAndAlternate, reconstructAlternateFromGainMap } from './image-processing.js';
import { createIsoMetadata, packGainmapJpeg, unpackGainmapJpeg } from './iso21496.js';
import {
  blobToImage,
  canvasToJpegBlob,
  downloadBlob,
  fileSizeText,
  fileToUint8Array,
  imageBitmapToCanvas,
} from './utils.js';

const state = {
  baseBitmap: null,
  altBitmap: null,
  encoded: null,
  decoded: null,
};

const el = {
  tabEncode: document.getElementById('tab-encode'),
  tabDecode: document.getElementById('tab-decode'),
  panelEncode: document.getElementById('panel-encode'),
  panelDecode: document.getElementById('panel-decode'),

  fileBase: document.getElementById('file-base'),
  fileAlt: document.getElementById('file-alt'),
  fileGainmapJpeg: document.getElementById('file-gainmap-jpeg'),

  btnOpenBase: document.getElementById('btn-open-base'),
  btnOpenAlt: document.getElementById('btn-open-alt'),
  btnReset: document.getElementById('btn-reset'),
  btnEncode: document.getElementById('btn-encode'),

  btnSaveGainmapHdr: document.getElementById('btn-save-gainmap-hdr'),
  btnSaveBase: document.getElementById('btn-save-base'),
  btnSaveGainmap: document.getElementById('btn-save-gainmap'),
  btnSaveAlt: document.getElementById('btn-save-alt'),

  previewBase: document.getElementById('preview-base'),
  previewAlt: document.getElementById('preview-alt'),
  previewResult: document.getElementById('preview-result'),
  resultMeta: document.getElementById('result-meta'),

  resultShowBase: document.getElementById('result-show-base'),
  resultShowAlt: document.getElementById('result-show-alt'),
  resultShowGainmap: document.getElementById('result-show-gainmap'),

  btnOpenGainmapJpeg: document.getElementById('btn-open-gainmap-jpeg'),
  decodeBase: document.getElementById('decode-base'),
  decodeGainmap: document.getElementById('decode-gainmap'),
  decodeAlt: document.getElementById('decode-alt'),
  decodeMetadata: document.getElementById('decode-metadata'),
  btnExportDecBase: document.getElementById('btn-export-dec-base'),
  btnExportDecGain: document.getElementById('btn-export-dec-gain'),
  btnExportDecAlt: document.getElementById('btn-export-dec-alt'),

  imageQuality: document.getElementById('image-quality'),
  imageQualityValue: document.getElementById('image-quality-value'),
  imageScale: document.getElementById('image-scale'),
  imageScaleValue: document.getElementById('image-scale-value'),
  bgColor: document.getElementById('bg-color'),
  targetDisplay: document.getElementById('target-display'),
  scaleMode: document.getElementById('scale-mode'),
  gainmapGamma: document.getElementById('gainmap-gamma'),
  gainmapGammaValue: document.getElementById('gainmap-gamma-value'),
  gainmapOffset: document.getElementById('gainmap-offset'),
  gainmapOffsetValue: document.getElementById('gainmap-offset-value'),

  zoneBase: document.getElementById('zone-base'),
  zoneAlt: document.getElementById('zone-alt'),
};

function activateTab(isEncode) {
  el.tabEncode.classList.toggle('active', isEncode);
  el.tabDecode.classList.toggle('active', !isEncode);
  el.panelEncode.classList.toggle('active', isEncode);
  el.panelDecode.classList.toggle('active', !isEncode);
}

function refreshControlLabels() {
  el.imageQualityValue.textContent = el.imageQuality.value;
  el.imageScaleValue.textContent = `${Math.round(Number(el.imageScale.value) * 100)}%`;
  el.gainmapGammaValue.textContent = Number(el.gainmapGamma.value).toFixed(1);
  el.gainmapOffsetValue.textContent = Number(el.gainmapOffset.value).toFixed(1);
}

function enableEncodeExports(enabled) {
  el.btnSaveGainmapHdr.disabled = !enabled;
  el.btnSaveBase.disabled = !enabled;
  el.btnSaveGainmap.disabled = !enabled;
  el.btnSaveAlt.disabled = !enabled;
}

function setResultPreview(kind) {
  if (!state.encoded) return;
  const map = {
    base: state.encoded.baseCanvas,
    alternate: state.encoded.alternateCanvas,
    gainmap: state.encoded.gainMapCanvas,
  };
  const canvas = map[kind];
  if (canvas) {
    el.previewResult.src = canvas.toDataURL('image/png');
  }
  el.resultShowBase.classList.toggle('active', kind === 'base');
  el.resultShowAlt.classList.toggle('active', kind === 'alternate');
  el.resultShowGainmap.classList.toggle('active', kind === 'gainmap');
}

async function handleImageInput(file, target) {
  const bitmap = await blobToImage(file);
  if (target === 'base') {
    state.baseBitmap = bitmap;
    el.previewBase.src = URL.createObjectURL(file);
  } else {
    state.altBitmap = bitmap;
    el.previewAlt.src = URL.createObjectURL(file);
  }
}

async function encode() {
  if (!state.altBitmap) {
    alert('里图是必需项');
    return;
  }

  const { baseCanvas, alternateCanvas, outW, outH } = composeBaseAndAlternate({
    baseBitmap: state.baseBitmap,
    alternateBitmap: state.altBitmap,
    targetDisplay: el.targetDisplay.value,
    imageScale: Number(el.imageScale.value),
    scaleMode: el.scaleMode.value,
    backgroundColor: el.bgColor.value,
  });

  const gamma = Number(el.gainmapGamma.value);
  const offset = Number(el.gainmapOffset.value);
  const gain = buildGainMap({ baseCanvas, alternateCanvas, gamma, offset });

  const metadata = createIsoMetadata({
    gamma: [gamma, gamma, gamma],
    offsetSdr: [offset, offset, offset],
    offsetHdr: [offset, offset, offset],
    minContentBoost: gain.minContentBoost,
    maxContentBoost: gain.maxContentBoost,
    hdrCapacityMin: 1,
    hdrCapacityMax: Math.max(...gain.maxContentBoost, 1.0001),
    useBaseColorSpace: 1,
  });

  const quality = Number(el.imageQuality.value);
  const baseBlob = await canvasToJpegBlob(baseCanvas, quality);
  const gainBlob = await canvasToJpegBlob(gain.gainMapCanvas, quality);

  const baseJpegBytes = new Uint8Array(await baseBlob.arrayBuffer());
  const gainmapJpegBytes = new Uint8Array(await gainBlob.arrayBuffer());
  const gainmapHdrJpegBytes = packGainmapJpeg({ baseJpegBytes, gainmapJpegBytes, metadata });

  state.encoded = {
    baseCanvas,
    alternateCanvas,
    gainMapCanvas: gain.gainMapCanvas,
    metadata,
    baseBlob,
    gainBlob,
    altBlob: await canvasToJpegBlob(alternateCanvas, quality),
    gainmapHdrBlob: new Blob([gainmapHdrJpegBytes], { type: 'image/jpeg' }),
    width: outW,
    height: outH,
  };

  el.resultMeta.textContent = [
    `分辨率: ${outW} x ${outH}`,
    `基础图: ${fileSizeText(state.encoded.baseBlob.size)}`,
    `增益图: ${fileSizeText(state.encoded.gainBlob.size)}`,
    `封装增益图 JPG: ${fileSizeText(state.encoded.gainmapHdrBlob.size)}`,
    `minBoost: ${gain.minContentBoost.map((x) => x.toFixed(4)).join(', ')}`,
    `maxBoost: ${gain.maxContentBoost.map((x) => x.toFixed(4)).join(', ')}`,
  ].join('\n');

  enableEncodeExports(true);
  setResultPreview('base');
}

function resetEncode() {
  state.baseBitmap = null;
  state.altBitmap = null;
  state.encoded = null;
  el.previewBase.removeAttribute('src');
  el.previewAlt.removeAttribute('src');
  el.previewResult.removeAttribute('src');
  el.resultMeta.textContent = '';
  enableEncodeExports(false);
}

async function decodeGainmapJpeg(file) {
  const bytes = await fileToUint8Array(file);
  const unpacked = unpackGainmapJpeg(bytes);

  const baseBlob = new Blob([unpacked.baseJpegBytes], { type: 'image/jpeg' });
  const gainBlob = new Blob([unpacked.gainmapJpegBytes], { type: 'image/jpeg' });

  const baseBitmap = await blobToImage(baseBlob);
  const gainBitmap = await blobToImage(gainBlob);

  const baseCanvas = imageBitmapToCanvas(baseBitmap);
  const gainMapCanvas = imageBitmapToCanvas(gainBitmap);
  const altCanvas = reconstructAlternateFromGainMap({
    baseCanvas,
    gainMapCanvas,
    metadata: unpacked.metadata,
  });

  state.decoded = {
    baseCanvas,
    gainMapCanvas,
    altCanvas,
    baseBlob,
    gainBlob,
    altBlob: await canvasToJpegBlob(altCanvas, 95),
    metadata: unpacked.metadata,
  };

  el.decodeBase.src = baseCanvas.toDataURL('image/png');
  el.decodeGainmap.src = gainMapCanvas.toDataURL('image/png');
  el.decodeAlt.src = altCanvas.toDataURL('image/png');

  el.decodeMetadata.textContent = [
    `gamma: ${unpacked.metadata.gamma.map((x) => x.toFixed(4)).join(', ')}`,
    `offsetSdr: ${unpacked.metadata.offsetSdr.map((x) => x.toFixed(4)).join(', ')}`,
    `offsetHdr: ${unpacked.metadata.offsetHdr.map((x) => x.toFixed(4)).join(', ')}`,
    `minBoost: ${unpacked.metadata.minContentBoost.map((x) => x.toFixed(4)).join(', ')}`,
    `maxBoost: ${unpacked.metadata.maxContentBoost.map((x) => x.toFixed(4)).join(', ')}`,
  ].join('\n');

  el.btnExportDecBase.disabled = false;
  el.btnExportDecGain.disabled = false;
  el.btnExportDecAlt.disabled = false;
}

function bindEvents() {
  el.tabEncode.addEventListener('click', () => activateTab(true));
  el.tabDecode.addEventListener('click', () => activateTab(false));

  el.imageQuality.addEventListener('input', refreshControlLabels);
  el.imageScale.addEventListener('input', refreshControlLabels);
  el.gainmapGamma.addEventListener('input', refreshControlLabels);
  el.gainmapOffset.addEventListener('input', refreshControlLabels);

  el.btnOpenBase.addEventListener('click', () => el.fileBase.click());
  el.btnOpenAlt.addEventListener('click', () => el.fileAlt.click());
  el.fileBase.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await handleImageInput(file, 'base');
  });
  el.fileAlt.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await handleImageInput(file, 'alternate');
  });

  const bindDrop = (zone, target) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.style.borderColor = '#2b5fe7';
    });
    zone.addEventListener('dragleave', () => {
      zone.style.borderColor = '#555';
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.style.borderColor = '#555';
      const file = e.dataTransfer?.files?.[0];
      if (file) await handleImageInput(file, target);
    });
  };
  bindDrop(el.zoneBase, 'base');
  bindDrop(el.zoneAlt, 'alternate');

  el.btnEncode.addEventListener('click', () => encode().catch((err) => alert(err.message)));
  el.btnReset.addEventListener('click', resetEncode);

  el.resultShowBase.addEventListener('click', () => setResultPreview('base'));
  el.resultShowAlt.addEventListener('click', () => setResultPreview('alternate'));
  el.resultShowGainmap.addEventListener('click', () => setResultPreview('gainmap'));

  el.btnSaveGainmapHdr.addEventListener('click', () => {
    if (!state.encoded) return;
    downloadBlob(state.encoded.gainmapHdrBlob, 'output_gainmap_hdr.jpg');
  });
  el.btnSaveBase.addEventListener('click', () => {
    if (!state.encoded) return;
    downloadBlob(state.encoded.baseBlob, 'output_base.jpg');
  });
  el.btnSaveGainmap.addEventListener('click', () => {
    if (!state.encoded) return;
    downloadBlob(state.encoded.gainBlob, 'output_gainmap.jpg');
  });
  el.btnSaveAlt.addEventListener('click', () => {
    if (!state.encoded) return;
    downloadBlob(state.encoded.altBlob, 'output_alternate.jpg');
  });

  el.btnOpenGainmapJpeg.addEventListener('click', () => el.fileGainmapJpeg.click());
  el.fileGainmapJpeg.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await decodeGainmapJpeg(file).catch((err) => alert(err.message));
    }
  });

  el.btnExportDecBase.addEventListener('click', () => {
    if (state.decoded) downloadBlob(state.decoded.baseBlob, 'decoded_base.jpg');
  });
  el.btnExportDecGain.addEventListener('click', () => {
    if (state.decoded) downloadBlob(state.decoded.gainBlob, 'decoded_gainmap.jpg');
  });
  el.btnExportDecAlt.addEventListener('click', () => {
    if (state.decoded) downloadBlob(state.decoded.altBlob, 'decoded_alternate.jpg');
  });
}

bindEvents();
refreshControlLabels();
enableEncodeExports(false);