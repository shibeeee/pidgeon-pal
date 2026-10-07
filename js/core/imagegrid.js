/*
 * Reading a board from a screenshot.
 *
 * GP.gridFromImage opens a dialog: pick a screenshot, drag the grid's corners
 * over the board, and it hands back the average color of every cell plus a
 * way to crop each cell (used for reading letters). The grid position is
 * remembered per game, since screenshots from one phone line up the same way.
 *
 * GP.readLetters runs Tesseract (vendor/tesseract, Apache-2.0) on cell crops.
 */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  GP.gridFromImage = function (opts) {
    const { rows, cols, mask } = opts;
    const saveKey = 'grid:' + (opts.key || rows + 'x' + cols);
    let img = null;
    let rect = GP.store.get(saveKey, { x: 0.08, y: 0.3, w: 0.84, h: 0.84 * (rows / cols) * 0.5 });
    const stage = h('div', { class: 'ig-stage' });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'ig-file', onchange: (e) => load(e.target.files[0]) });
    const pick = h('label', { class: 'ig-pick' }, file, GP.icon('upload'), h('b', null, 'Choose a screenshot'),
      h('small', null, 'Take a screenshot of your game first'));
    const body = h('div', { class: 'ig' }, h('p', { class: 'hint-text' }, opts.help || 'Drag the corners so the grid lines up with the board.'), pick, stage);
    let readBtnWrap;
    const m = GP.modal(opts.title || 'Read from screenshot', body, [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Read board', kind: 'primary', keepOpen: true, onclick: () => readNow() },
    ]);
    readBtnWrap = m.el.querySelector('footer .btn-primary');
    readBtnWrap.disabled = true;

    function load(f) {
      if (!f) return;
      const url = URL.createObjectURL(f);
      img = new Image();
      img.onload = () => { pick.classList.add('small'); draw(); readBtnWrap.disabled = false; };
      img.src = url;
    }

    function draw() {
      GP.clear(stage);
      const pic = h('img', { src: img.src, class: 'ig-img', alt: 'Screenshot' });
      const box = h('div', { class: 'ig-box' });
      // grid lines
      const lines = h('svg:svg', { class: 'ig-lines', viewBox: `0 0 ${cols} ${rows}`, preserveAspectRatio: 'none' });
      for (let c = 1; c < cols; c++) lines.appendChild(h('svg:line', { x1: c, y1: 0, x2: c, y2: rows }));
      for (let r = 1; r < rows; r++) lines.appendChild(h('svg:line', { x1: 0, y1: r, x2: cols, y2: r }));
      if (mask) mask.forEach((on, i) => { if (!on) lines.appendChild(h('svg:rect', { x: i % cols, y: Math.floor(i / cols), width: 1, height: 1, class: 'ig-hole' })); });
      box.appendChild(lines);
      const handles = ['tl', 'br'].map((k) => h('i', { class: 'ig-h ' + k, dataset: { k } }));
      box.append(...handles, h('i', { class: 'ig-move', dataset: { k: 'move' } }));
      stage.append(pic, box);
      const place = () => {
        Object.assign(box.style, { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%' });
      };
      place();
      let drag = null;
      box.addEventListener('pointerdown', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        e.preventDefault();
        box.setPointerCapture(e.pointerId);
        drag = { k, x: e.clientX, y: e.clientY, r: Object.assign({}, rect) };
      });
      box.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const b = stage.getBoundingClientRect();
        const dx = (e.clientX - drag.x) / b.width, dy = (e.clientY - drag.y) / b.height;
        const r = drag.r;
        if (drag.k === 'move') { rect.x = r.x + dx; rect.y = r.y + dy; }
        else if (drag.k === 'tl') { rect.x = r.x + dx; rect.y = r.y + dy; rect.w = r.w - dx; rect.h = r.h - dy; }
        else { rect.w = r.w + dx; rect.h = r.h + dy; }
        rect.w = Math.max(0.05, rect.w); rect.h = Math.max(0.03, rect.h);
        place();
      });
      box.addEventListener('pointerup', () => { drag = null; GP.store.set(saveKey, rect); });
    }

    function readNow() {
      if (!img) return;
      GP.store.set(saveKey, rect);
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const cw = rect.w * cv.width / cols, ch = rect.h * cv.height / rows;
      const cell = (i, inset) => {
        const r = Math.floor(i / cols), c = i % cols;
        const x = rect.x * cv.width + c * cw, y = rect.y * cv.height + r * ch;
        const k = inset == null ? 0.25 : inset;
        return [Math.round(x + cw * k), Math.round(y + ch * k), Math.max(1, Math.round(cw * (1 - 2 * k))), Math.max(1, Math.round(ch * (1 - 2 * k)))];
      };
      const samples = [];
      for (let i = 0; i < rows * cols; i++) {
        const [x, y, w, hh] = cell(i);
        const d = ctx.getImageData(x, y, w, hh).data;
        let R = 0, G = 0, B = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) { R += d[k]; G += d[k + 1]; B += d[k + 2]; n++; }
        samples.push([R / n, G / n, B / n]);
      }
      const api = {
        crop(i, inset) {
          const [x, y, w, hh] = cell(i, inset == null ? 0.08 : inset);
          const out = document.createElement('canvas');
          out.width = w; out.height = hh;
          out.getContext('2d').drawImage(cv, x, y, w, hh, 0, 0, w, hh);
          return out;
        },
      };
      m.close();
      opts.read(samples, api);
    }
  };

  /* ---------- Letters (Tesseract OCR) ---------- */
  let tess = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function worker() {
    if (tess) return tess;
    const abs = (p) => new URL(p, location.href).href;
    tess = loadScript('vendor/tesseract/tesseract.min.js').then(async () => {
      const w = await window.Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core'),
        langPath: abs('vendor/tesseract/lang'),
        gzip: true,
      });
      await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', tessedit_pageseg_mode: '10' });
      return w;
    });
    tess.catch(() => { tess = null; });
    return tess;
  }

  /*
   * Cleans a tile crop for OCR: finds the letter, drops anything touching
   * the tile's edge (borders, shadows), crops tight and redraws it as a big
   * black letter on white. Returns null for an empty tile.
   */
  function prepare(src) {
    const W = 72, H = 72;
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(src, 0, 0, W, H);
    const px = tctx.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H), hist = new Array(256).fill(0);
    for (let j = 0; j < W * H; j++) {
      lum[j] = 0.299 * px[j * 4] + 0.587 * px[j * 4 + 1] + 0.114 * px[j * 4 + 2];
      hist[lum[j] | 0]++;
    }
    // Otsu threshold
    let sum = 0, sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = W * H - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; t = i; }
    }
    let dark = 0;
    for (let j = 0; j < W * H; j++) if (lum[j] < t) dark++;
    const darkInk = dark < W * H / 2; // the letter is the minority color
    const ink = new Uint8Array(W * H);
    for (let j = 0; j < W * H; j++) ink[j] = darkInk ? lum[j] < t : lum[j] >= t;
    // Remove ink connected to the border.
    const stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const j = stack.pop();
      if (!ink[j]) continue;
      ink[j] = 0;
      const x = j % W, y = (j / W) | 0;
      if (x > 0) stack.push(j - 1);
      if (x < W - 1) stack.push(j + 1);
      if (y > 0) stack.push(j - W);
      if (y < H - 1) stack.push(j + W);
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    for (let j = 0; j < W * H; j++) {
      if (!ink[j]) continue;
      n++;
      const x = j % W, y = (j / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (n < W * H * 0.01) return null; // blank tile
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const mask = document.createElement('canvas');
    mask.width = bw; mask.height = bh;
    const mctx = mask.getContext('2d');
    const md = mctx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const v = ink[(y + y0) * W + (x + x0)] ? 0 : 255;
      const k = (y * bw + x) * 4;
      md.data[k] = md.data[k + 1] = md.data[k + 2] = v; md.data[k + 3] = 255;
    }
    mctx.putImageData(md, 0, 0);
    const LH = 64, scale = LH / bh, lw = Math.max(8, Math.round(bw * scale)), pad = 36;
    const out = document.createElement('canvas');
    out.width = lw + pad * 2; out.height = LH + pad * 2;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.imageSmoothingEnabled = true;
    octx.drawImage(mask, pad, pad, lw, LH);
    // Shape clues for letters OCR often misses (a bare "I" bar, an "O" ring).
    const fill = n / (bw * bh);
    let hole = false;
    {
      // background pixels inside the bbox that can't reach the bbox edge = a hole
      const seen = new Uint8Array(bw * bh), st = [];
      const bg = (x, y) => !ink[(y + y0) * W + (x + x0)];
      for (let x = 0; x < bw; x++) { st.push(x, (bh - 1) * bw + x); }
      for (let y = 0; y < bh; y++) { st.push(y * bw, y * bw + bw - 1); }
      while (st.length) {
        const j = st.pop();
        const x = j % bw, y = (j / bw) | 0;
        if (seen[j] || !bg(x, y)) continue;
        seen[j] = 1;
        if (x > 0) st.push(j - 1);
        if (x < bw - 1) st.push(j + 1);
        if (y > 0) st.push(j - bw);
        if (y < bh - 1) st.push(j + bw);
      }
      let holes = 0;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (bg(x, y) && !seen[y * bw + x]) holes++;
      hole = holes > bw * bh * 0.08;
      out.holes = holes;
      out.center = bg(bw >> 1, bh >> 1);
    }
    out.shape = { aspect: bw / bh, fill, hole, holes: out.holes, centerEmpty: out.center };
    return out;
  }

  /* Best guess from shape alone, for tiles the OCR engine left blank. */
  function guessFromShape(f) {
    if (!f) return '';
    if (f.aspect < 0.38 && f.fill > 0.75) return 'I';
    if (f.hole && f.centerEmpty && f.aspect > 0.75 && f.aspect < 1.25 && f.fill < 0.6) return 'O';
    return '';
  }

  /* Reads one letter from each canvas. Resolves an array of letters ('' when unsure). */
  GP.readLetters = async function (canvases, onProgress) {
    const w = await worker();
    const clean = canvases.map((c) => (c ? prepare(c) : null));
    const out = [];
    const read = async (img) => {
      const { data } = await w.recognize(img);
      const ch = (data.text || '').replace(/[^A-Z]/g, '');
      return ch ? ch[0] : '';
    };
    for (let i = 0; i < clean.length; i++) {
      out.push(clean[i] ? await read(clean[i]) : '');
      if (onProgress) onProgress(i + 1, clean.length);
    }
    // Second try for anything unread, treating it as a one-word line.
    if (out.some((x, i) => !x && clean[i])) {
      await w.setParameters({ tessedit_pageseg_mode: '8' });
      for (let i = 0; i < clean.length; i++) if (!out[i] && clean[i]) out[i] = await read(clean[i]);
      await w.setParameters({ tessedit_pageseg_mode: '10' });
    }
    for (let i = 0; i < clean.length; i++) {
      if (!clean[i]) continue;
      if (!out[i]) out[i] = guessFromShape(clean[i].shape);
      else if (out[i] === 'A' && clean[i].shape.holes === 0) out[i] = 'V'; // an A always has a hole
    }
    return out;
  };

  /* Word games: screenshot -> letters -> tiles. */
  GP.lettersFromScreenshot = function (opts) {
    GP.gridFromImage({
      rows: opts.rows, cols: opts.cols, mask: opts.mask, key: opts.key,
      title: 'Read letters from a screenshot',
      help: 'Drag the corners of the grid onto the outer edges of the letter tiles. Next time it will already be in place.',
      read: async (samples, api) => {
        const n = opts.rows * opts.cols;
        const crops = [];
        for (let i = 0; i < n; i++) crops.push(opts.mask && !opts.mask[i] ? null : api.crop(i, 0.14));
        GP.toast('Reading letters…');
        try {
          const letters = await GP.readLetters(crops);
          const missing = letters.filter((x, i) => !x && crops[i]).length;
          opts.done(letters);
          GP.toast(missing ? 'Filled in. ' + GP.plural(missing, 'tile') + ' could not be read, please type ' + (missing > 1 ? 'them' : 'it') + '.' : 'Letters filled in. Double-check them.', missing ? 'warn' : 'good');
        } catch (e) {
          GP.toast('Could not read the screenshot: ' + e.message, 'error');
        }
      },
    });
  };
})();
