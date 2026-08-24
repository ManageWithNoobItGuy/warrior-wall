/**
 * Poster renderer — draws the whole warrior card onto a canvas, client side.
 *
 * Everything here is deterministic pixel work: no network, no image API, so a
 * poster appears the instant a student hits confirm even on classroom wifi.
 */

// Layout is authored in these design units; the canvas is rendered at SCALE×
// them. The AI avatar arrives at 1024², so a 1× card would throw away half its
// detail when fitting it into the ~500-unit portrait.
export const POSTER_W = 1080;
export const POSTER_H = 1440;
export const POSTER_SCALE = 2;

const PAL = {
  edge: '#04040e',
  frameOuter: '#0a0a24',
  cream: '#f4efe2',
  gold: '#ffd75e',
  amber: '#e0901f',
  cyan: '#63e7ff',
  magenta: '#ff6ec7',
  leaf: '#7cf07c',
  dim: '#a9a6d8',
  panelA: '#2a2a80',
  panelB: '#111134',
  slot: '#0a0a22',
};

const FONT_PIXEL = '"Press Start 2P"';
const FONT_BODY = '"Noto Sans Thai"';

let fontsReady;

/**
 * Canvas silently substitutes fonts that are not loaded yet — force them in.
 * The sample text carries Thai characters on purpose: the interface is English,
 * but a student may still type Thai, and only a Thai sample pulls in that
 * subset of the webfont.
 */
export function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load(`24px ${FONT_PIXEL}`, 'ABC 123'),
      document.fonts.load(`400 32px ${FONT_BODY}`, 'ทดสอบ Abc'),
      document.fonts.load(`700 32px ${FONT_BODY}`, 'ทดสอบ Abc'),
    ]).then(() => document.fonts.ready);
  }
  return fontsReady;
}

// ------------------------------------------------------------ text wrapping

const wordSeg =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('th', { granularity: 'word' })
    : null;
const graphemeSeg =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter('th', { granularity: 'grapheme' })
    : null;

/**
 * Thai runs together without spaces, so splitting on whitespace alone produces
 * one giant unbreakable "word". Intl.Segmenter knows where Thai words end;
 * graphemes are the last-resort break so tone marks never split off their base.
 */
function segments(text) {
  if (wordSeg) return [...wordSeg.segment(text)].map((s) => s.segment);
  return text.split(/(\s+)/);
}

function graphemes(text) {
  if (graphemeSeg) return [...graphemeSeg.segment(text)].map((s) => s.segment);
  return [...text];
}

export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';

  const push = () => {
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
  };

  for (const piece of segments(text)) {
    if (piece === '\n') {
      push();
      continue;
    }
    const candidate = line + piece;
    if (ctx.measureText(candidate).width <= maxWidth || !line.trim()) {
      // A single segment wider than the column still has to break somewhere.
      if (ctx.measureText(candidate).width > maxWidth && !line.trim()) {
        let chunk = '';
        for (const g of graphemes(piece)) {
          if (ctx.measureText(chunk + g).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = g;
          } else {
            chunk += g;
          }
        }
        line = chunk;
        continue;
      }
      line = candidate;
    } else {
      push();
      line = piece.trimStart();
    }
  }
  push();
  return lines.length ? lines : [''];
}

// ------------------------------------------------------------ pixel drawing

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Hard-edged bevel: black outline, cream keyline, coloured fill. */
function panel(ctx, x, y, w, h, { fill = null, keyline = PAL.cream, border = 4 } = {}) {
  rect(ctx, x - border * 2, y - border * 2, w + border * 4, h + border * 4, PAL.edge);
  rect(ctx, x - border, y - border, w + border * 2, h + border * 2, keyline);
  if (fill) {
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, fill[0]);
    grad.addColorStop(1, fill[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  } else {
    rect(ctx, x, y, w, h, PAL.slot);
  }
}

function star(ctx, cx, cy, size, color) {
  const u = size / 5;
  rect(ctx, cx - u / 2, cy - u * 2.5, u, u * 5, color);
  rect(ctx, cx - u * 2.5, cy - u / 2, u * 5, u, color);
  rect(ctx, cx - u * 1.5, cy - u * 1.5, u, u, color);
  rect(ctx, cx + u * 0.5, cy - u * 1.5, u, u, color);
  rect(ctx, cx - u * 1.5, cy + u * 0.5, u, u, color);
  rect(ctx, cx + u * 0.5, cy + u * 0.5, u, u, color);
}

/** Stepped diamond: four widening rows mirrored around the middle. */
function gem(ctx, cx, cy, size, color, outline = PAL.edge) {
  const draw = (s, fill) => {
    const u = s / 8;
    for (let i = 0; i < 4; i++) {
      const w = (i + 1) * 2 * u;
      rect(ctx, cx - w / 2, cy - s / 2 + i * u, w, u, fill);
      rect(ctx, cx - w / 2, cy + s / 2 - (i + 1) * u, w, u, fill);
    }
  };
  if (outline) draw(size + 6, outline);
  draw(size, color);
}

/** Numbered plate used for list markers — square reads far better than a diamond. */
function plate(ctx, cx, cy, size, color, label) {
  rect(ctx, cx - size / 2 - 4, cy - size / 2 - 4, size + 8, size + 8, PAL.edge);
  rect(ctx, cx - size / 2, cy - size / 2, size, size, color);
  rect(ctx, cx - size / 2, cy - size / 2, size, 4, 'rgba(255,255,255,0.45)');
  ctx.font = `${Math.round(size * 0.46)}px ${FONT_PIXEL}`;
  ctx.fillStyle = PAL.edge;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

function pixelText(ctx, text, x, y, size, color, { shadow = PAL.edge, align = 'left' } = {}) {
  ctx.font = `${size}px ${FONT_PIXEL}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  if (shadow) {
    ctx.fillStyle = shadow;
    ctx.fillText(text, x + Math.max(2, size * 0.09), y + Math.max(2, size * 0.09));
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

// ------------------------------------------------------------ photo

/**
 * Centre-crops to a square and, when asked, knocks the photo down to a chunky
 * low-res palette so it sits inside the 24-bit frame instead of on top of it.
 */
export function processPhoto(image, size, { pixelate = true, blocks = 112 } = {}) {
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');

  const side = Math.min(image.width, image.height);
  const sx = (image.width - side) / 2;
  const sy = (image.height - side) / 2;

  if (!pixelate) {
    ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
    return out;
  }

  const small = document.createElement('canvas');
  small.width = blocks;
  small.height = blocks;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(image, sx, sy, side, side, 0, 0, blocks, blocks);

  try {
    const data = sctx.getImageData(0, 0, blocks, blocks);
    const px = data.data;
    const levels = 12; // posterise: enough shades for skin tones, few enough to read as retro
    const stepSize = 255 / (levels - 1);
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = px[i + c];
        const boosted = Math.min(255, Math.max(0, 128 + (v - 128) * 1.14));
        px[i + c] = Math.round(Math.round(boosted / stepSize) * stepSize);
      }
    }
    sctx.putImageData(data, 0, 0);
  } catch {
    /* getImageData can throw on a tainted canvas; the un-posterised photo is fine */
  }

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, blocks, blocks, 0, 0, size, size);
  return out;
}

// ------------------------------------------------------------ the poster

/** Backdrop for a card with no class chosen — the original indigo. */
const DEFAULT_THEME = {
  bg: ['#1b1b5e', '#101034', '#08081f'],
  plate: ['#3b1f6e', '#180a35'],
};

function drawBackdrop(ctx, theme, accent) {
  const grad = ctx.createLinearGradient(0, 0, 0, POSTER_H);
  grad.addColorStop(0, theme.bg[0]);
  grad.addColorStop(0.55, theme.bg[1]);
  grad.addColorStop(1, theme.bg[2]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  // dither band across the upper half — cheap 24-bit sky texture
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 0; y < POSTER_H * 0.62; y += 8) {
    const density = 1 - y / (POSTER_H * 0.62);
    for (let x = ((y / 8) % 2) * 8; x < POSTER_W; x += 16) {
      if (Math.random() < density * 0.5) ctx.fillRect(x, y, 4, 4);
    }
  }

  // starfield
  for (let i = 0; i < 90; i++) {
    const x = Math.round(Math.random() * POSTER_W);
    const y = Math.round(Math.random() * POSTER_H * 0.55);
    const s = Math.random() < 0.2 ? 6 : 3;
    ctx.fillStyle = `rgba(255,255,255,${0.18 + Math.random() * 0.5})`;
    ctx.fillRect(x, y, s, s);
  }

  // Outer frame drawn as four bands — filling the whole canvas first would
  // erase the dither and starfield we just laid down.
  rect(ctx, 0, 0, POSTER_W, 12, PAL.edge);
  rect(ctx, 0, POSTER_H - 12, POSTER_W, 12, PAL.edge);
  rect(ctx, 0, 0, 12, POSTER_H, PAL.edge);
  rect(ctx, POSTER_W - 12, 0, 12, POSTER_H, PAL.edge);

  rect(ctx, 12, 12, POSTER_W - 24, 6, PAL.gold);
  rect(ctx, 12, POSTER_H - 18, POSTER_W - 24, 6, PAL.gold);
  rect(ctx, 12, 12, 6, POSTER_H - 24, PAL.gold);
  rect(ctx, POSTER_W - 18, 12, 6, POSTER_H - 24, PAL.gold);

  for (const [cx, cy] of [
    [34, 34],
    [POSTER_W - 34, 34],
    [34, POSTER_H - 34],
    [POSTER_W - 34, POSTER_H - 34],
  ]) {
    gem(ctx, cx, cy, 22, accent);
  }
}

/**
 * CRT lines over the card, but never across the portrait — the face is the one
 * thing on here that has to stay clean, and striping it is what makes an avatar
 * hard to recognise.
 *
 * @param {{x: number, y: number, size: number}} [keepClear] portrait rect to skip
 */
function drawScanlines(ctx, keepClear) {
  ctx.save();
  if (keepClear) {
    // Even-odd over two rects clips to "everything except the portrait".
    ctx.beginPath();
    ctx.rect(0, 0, POSTER_W, POSTER_H);
    ctx.rect(keepClear.x, keepClear.y, keepClear.size, keepClear.size);
    ctx.clip('evenodd');
  }
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  for (let y = 0; y < POSTER_H; y += 4) ctx.fillRect(0, y, POSTER_W, 2);
  ctx.restore();
}

const TITLE_SIZE = 22;
const TITLE_GAP = 26;
const MARKER_COL = 74;

function listMetrics(bodySize) {
  return {
    lineH: Math.round(bodySize * 1.62),
    itemGap: Math.round(bodySize * 0.85),
  };
}

function listBlock(ctx, { title, items, accent, x, y, width, bodySize, marker }) {
  const { lineH, itemGap } = listMetrics(bodySize);
  const textX = x + MARKER_COL;
  const textW = width - MARKER_COL;

  pixelText(ctx, title, x + 6, y, TITLE_SIZE, accent);
  let cursor = y + TITLE_SIZE + TITLE_GAP;

  items.forEach((item, i) => {
    ctx.font = `500 ${bodySize}px ${FONT_BODY}`;
    const lines = wrapText(ctx, item, textW);

    plate(
      ctx,
      x + 28,
      cursor + lineH / 2 - 2,
      Math.round(bodySize * 1.15),
      accent,
      marker === 'number' ? String(i + 1) : '>',
    );

    ctx.font = `500 ${bodySize}px ${FONT_BODY}`;
    lines.forEach((line, li) => {
      const ly = cursor + li * lineH;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillText(line, textX + 3, ly + 3);
      ctx.fillStyle = PAL.cream;
      ctx.fillText(line, textX, ly);
    });

    cursor += lines.length * lineH + itemGap;
  });

  return cursor - y - itemGap;
}

function measureList(ctx, { items, width, bodySize }) {
  const { lineH, itemGap } = listMetrics(bodySize);
  ctx.font = `500 ${bodySize}px ${FONT_BODY}`;
  let h = TITLE_SIZE + TITLE_GAP;
  items.forEach((item, i) => {
    h += wrapText(ctx, item, width - MARKER_COL).length * lineH;
    if (i < items.length - 1) h += itemGap;
  });
  return h;
}

/**
 * @param {object} data
 * @param {string} data.name
 * @param {string} data.studentId
 * @param {string[]} data.takeaways
 * @param {string[]} data.actions
 * @param {HTMLImageElement|HTMLCanvasElement|null} data.photo
 * @param {string} [data.title] class/session name
 * @param {boolean} [data.pixelate]
 * @returns {HTMLCanvasElement}
 */
export function renderPoster(data) {
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_W * POSTER_SCALE;
  canvas.height = POSTER_H * POSTER_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(POSTER_SCALE, POSTER_SCALE);

  const title = (data.title || 'AI CLASS').toUpperCase();
  const takeaways = data.takeaways.filter(Boolean);
  const actions = data.actions.filter(Boolean);

  // Each class carries its own backdrop so a wall of cards reads as a party of
  // different characters rather than fifty copies of the same blue card.
  const theme = data.job?.card ?? DEFAULT_THEME;
  const accent = data.job?.accent ?? PAL.cyan;

  // ---- sizing: how much room the text needs decides how big the portrait gets
  const contentX = 76;
  const contentW = POSTER_W - 152;
  const footerTop = POSTER_H - 118;
  const portraitY = 186; // the old sub-title line under the banner is gone
  const portraitX = 76;
  const blockGap = 52;

  const totalFor = (size) =>
    measureList(ctx, { items: takeaways, width: contentW, bodySize: size }) +
    measureList(ctx, { items: actions, width: contentW, bodySize: size }) +
    blockGap;

  let portraitSize = 500;
  let bodySize = 40;
  let contentTop;
  let available;
  for (;;) {
    contentTop = portraitY + portraitSize + 46;
    available = footerTop - contentTop - 24;
    bodySize = 40;
    while (bodySize > 18 && totalFor(bodySize) > available) bodySize -= 1;
    // Give the portrait the leftover room, but never at the cost of legible text.
    if (bodySize >= 26 || portraitSize <= 340) break;
    portraitSize -= 20;
  }

  drawBackdrop(ctx, theme, accent);

  // ---- header plate carries the session name
  const headerY = 58;
  const plateH = 76;
  panel(ctx, 96, headerY, POSTER_W - 192, plateH, { fill: theme.plate, keyline: PAL.gold });
  star(ctx, 136, headerY + 38, 26, accent);
  star(ctx, POSTER_W - 136, headerY + 38, 26, accent);

  // Session names are free text, so the banner type shrinks to fit between the
  // two stars and truncates only as a last resort.
  const bannerMax = 700;
  let bannerSize = 30;
  let banner = title;
  ctx.font = `${bannerSize}px ${FONT_PIXEL}`;
  while (bannerSize > 12 && ctx.measureText(banner).width > bannerMax) {
    bannerSize -= 1;
    ctx.font = `${bannerSize}px ${FONT_PIXEL}`;
  }
  while (banner.length > 4 && ctx.measureText(banner).width > bannerMax) {
    banner = `${banner.slice(0, -2).trimEnd()}…`;
  }
  pixelText(ctx, banner, POSTER_W / 2, headerY + (plateH - bannerSize) / 2, bannerSize, PAL.gold, {
    align: 'center',
  });

  // ---- portrait + identity
  panel(ctx, portraitX, portraitY, portraitSize, portraitSize, {
    fill: [theme.bg[1], theme.bg[2]],
    keyline: PAL.cream,
  });

  if (data.photo) {
    const pixelate = data.pixelate !== false;
    // Built at device resolution so it lands 1:1 and keeps every pixel the
    // source had — building it at design size would upscale it back to blur.
    const framed = processPhoto(data.photo, portraitSize * POSTER_SCALE, {
      pixelate,
      // keep the pixel blocks the same visual size as the frame grows
      blocks: Math.round(portraitSize * 0.29),
    });
    ctx.imageSmoothingEnabled = !pixelate;
    ctx.drawImage(framed, portraitX, portraitY, portraitSize, portraitSize);
    ctx.imageSmoothingEnabled = true;
    // inner shading so the photo reads as inset
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 6;
    ctx.strokeRect(portraitX + 3, portraitY + 3, portraitSize - 6, portraitSize - 6);
  } else {
    pixelText(ctx, 'NO', portraitX + portraitSize / 2, portraitY + 130, 26, PAL.dim, {
      align: 'center',
    });
    pixelText(ctx, 'PHOTO', portraitX + portraitSize / 2, portraitY + 170, 26, PAL.dim, {
      align: 'center',
    });
  }

  const infoX = portraitX + portraitSize + 54;
  const infoW = POSTER_W - infoX - 76;
  let infoY = portraitY + 6;

  // "LV.1" alone, or "LV.1 MAGE" once a class has been summoned
  pixelText(ctx, 'LV.1', infoX, infoY, 18, PAL.gold);
  if (data.job?.label) {
    ctx.font = `18px ${FONT_PIXEL}`;
    const offset = ctx.measureText('LV.1 ').width;
    pixelText(ctx, data.job.label, infoX + offset, infoY, 18, data.job.accent ?? PAL.cyan);
  }
  infoY += 40;

  let nameSize = 50;
  ctx.font = `700 ${nameSize}px ${FONT_BODY}`;
  let nameLines = wrapText(ctx, data.name, infoW);
  while (nameLines.length > 2 && nameSize > 30) {
    nameSize -= 4;
    ctx.font = `700 ${nameSize}px ${FONT_BODY}`;
    nameLines = wrapText(ctx, data.name, infoW);
  }
  nameLines = nameLines.slice(0, 2);
  nameLines.forEach((line, i) => {
    const y = infoY + i * Math.round(nameSize * 1.25);
    ctx.font = `700 ${nameSize}px ${FONT_BODY}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = PAL.edge;
    ctx.fillText(line, infoX + 4, y + 4);
    ctx.fillStyle = PAL.cream;
    ctx.fillText(line, infoX, y);
  });
  infoY += nameLines.length * Math.round(nameSize * 1.25) + 10;

  pixelText(ctx, `ID ${data.studentId}`, infoX, infoY, 16, PAL.cyan);
  infoY += 42;

  const stats = [
    { label: 'INSIGHT', value: takeaways.length, max: 3, color: PAL.cyan },
    { label: 'RESOLVE', value: actions.length, max: 3, color: PAL.leaf },
  ];
  for (const stat of stats) {
    pixelText(ctx, stat.label, infoX, infoY, 13, PAL.dim, { shadow: null });
    const barY = infoY + 24;
    const barW = Math.min(infoW, 300);
    rect(ctx, infoX - 3, barY - 3, barW + 6, 24, PAL.edge);
    rect(ctx, infoX, barY, barW, 18, '#0a0a22');
    const filled = Math.round((barW - 6) * (stat.value / stat.max));
    rect(ctx, infoX + 3, barY + 3, filled, 12, stat.color);
    for (let i = 1; i < stat.max; i++) {
      rect(ctx, infoX + (barW / stat.max) * i, barY, 3, 18, PAL.edge);
    }
    infoY += 60;
  }

  // ---- content sections (portraitSize and bodySize were settled up top)
  // Whatever room is left gets split above and below so the card stays balanced.
  const slack = Math.max(0, available - totalFor(bodySize));
  let y = contentTop + Math.min(slack / 2, 70);
  const takeawayH = listBlock(ctx, {
    title: 'KEY TAKEAWAYS',
    items: takeaways,
    accent: PAL.cyan,
    x: contentX,
    y,
    width: contentW,
    bodySize,
    marker: 'number',
  });

  y += takeawayH + blockGap;
  rect(ctx, contentX, y - blockGap / 2, contentW, 4, 'rgba(255,255,255,0.16)');

  listBlock(ctx, {
    title: 'MY PLEDGE',
    items: actions,
    accent: data.job ? accent : PAL.gold,
    x: contentX,
    y,
    width: contentW,
    bodySize,
    marker: 'arrow',
  });

  // ---- footer
  rect(ctx, 40, footerTop, POSTER_W - 80, 4, 'rgba(255,255,255,0.2)');
  const stamp = new Date(data.createdAt ?? Date.now())
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase();
  pixelText(ctx, 'AI WARRIOR WALL OF PLEDGING', 62, footerTop + 34, 14, PAL.dim, { shadow: null });
  pixelText(ctx, stamp, POSTER_W - 62, footerTop + 34, 14, PAL.dim, {
    align: 'right',
    shadow: null,
  });

  drawScanlines(ctx, { x: portraitX, y: portraitY, size: portraitSize });
  return canvas;
}

/**
 * A display copy of the card. The full-resolution render is what students
 * download, but the wall loads every card at once and cannot afford it.
 */
export function scaleCanvas(source, width) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round(source.height * (width / source.width));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/** Canvas → Blob, so images can be PUT as raw bytes instead of base64 text. */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('could not encode image'))),
      type,
      quality,
    );
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}
