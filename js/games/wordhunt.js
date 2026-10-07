/* Word Hunt: find every word on the board and show how to swipe it. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  const LAYOUTS = {
    '4x4': { cols: 4, mask: null, count: 16, label: '4 × 4' },
    '5x5': { cols: 5, mask: null, count: 25, label: '5 × 5' },
    donut: { cols: 5, count: 25, label: 'Donut', mask: '01110' + '11111' + '11011' + '11111' + '01110' },
    cross: { cols: 5, count: 25, label: 'Cross', mask: '11011' + '11111' + '01110' + '11111' + '11011' },
  };
  for (const k in LAYOUTS) {
    const L = LAYOUTS[k];
    L.maskArr = L.mask ? L.mask.split('').map((c) => c === '1') : null;
  }


  function mount(root) {
    const st = Object.assign({ layout: '4x4', letters: {}, used: [], maxLen: 12, order: 'score' }, GP.store.get('wordhunt', {}));
    const save = () => GP.store.set('wordhunt', st);
    let results = [];
    let query = '';
    let used = new Set(st.used);
    let tiles, listEl = null;

    const boardHost = h('div', { class: 'wh-board' });
    const overlay = h('svg:svg', { class: 'wh-path', 'aria-hidden': 'true' });
    const stage = h('div', { class: 'wh-stage' }, boardHost, overlay);
    const side = h('div', { class: 'wh-side' });
    const quickHost = h('div', { class: 'quick-host' });

    const flow = GP.wordFlow({
      list: () => ordered(),
      keyOf: (x) => x.word,
      used: () => used,
      onUsed: () => { st.used = [...used]; save(); if (listEl) listEl.sync(); },
      onShow: (x, quiet) => {
        drawPath();
        if (listEl) listEl.sync(x ? x.word : null);
        if (!quiet) GP.showOnPhone(stage);
      },
      meta: (x) => GP.fmt(x.score) + ' points',
    });

    const layoutSeg = GP.segmented(Object.keys(LAYOUTS).map((k) => ({ value: k, label: LAYOUTS[k].label })), st.layout, (v) => {
      st.layout = v;
      save();
      buildBoard();
      solve();
    });

    root.appendChild(h('div', { class: 'game-layout word' },
      h('section', { class: 'play-area' },
        h('div', { class: 'toolbar' }, layoutSeg),
        stage,
        quickHost,
        flow.el,
        h('div', { class: 'btn-row' },
          GP.button('Screenshot', { icon: 'upload', title: 'Read the letters from a screenshot', onclick: () => {
            const L = LAYOUTS[st.layout];
            GP.lettersFromScreenshot({ rows: L.count / L.cols, cols: L.cols, mask: L.maskArr, key: 'wordhunt-' + st.layout, done: (letters) => tiles.setAll(letters) });
          } }),
          GP.button('Clear', { icon: 'trash', kind: 'ghost', onclick: clearBoard }))),
      h('aside', { class: 'panel' }, side)));

    function letters() {
      const L = LAYOUTS[st.layout];
      const arr = (st.letters[st.layout] || []).slice(0, L.count);
      while (arr.length < L.count) arr.push('');
      return arr;
    }

    function buildBoard() {
      const L = LAYOUTS[st.layout];
      GP.clear(boardHost);
      tiles = GP.tileInputs({
        count: L.count, cols: L.cols, mask: L.maskArr, values: letters(),
        className: 'wh-tiles size' + L.cols,
        onChange: (vals) => {
          st.letters[st.layout] = vals;
          save();
          solveSoon();
        },
      });
      boardHost.appendChild(tiles.el);
      GP.clear(quickHost).appendChild(GP.quickEntry(L.maskArr ? L.maskArr.filter(Boolean).length : L.count, () => tiles));
      drawPath();
    }

    function boardKey() { return st.layout + ':' + letters().join(''); }

    const solveSoon = GP.debounce(() => solve(), 120);
    function solve() {
      const L = LAYOUTS[st.layout];
      const vals = letters();
      const filled = vals.every((ch, i) => (L.maskArr && !L.maskArr[i]) || ch);
      if (st.usedKey !== boardKey()) { used = new Set(); st.usedKey = boardKey(); st.used = []; save(); }
      if (!filled) {
        results = [];
        flow.reset();
        renderSide(vals.filter(Boolean).length);
        drawPath();
        return;
      }
      if (!GP.words.ready()) { GP.clear(side); side.appendChild(GP.loadingCard()); }
      GP.loadWords().then(() => {
        const cells = vals.map((ch, i) => ((L.maskArr && !L.maskArr[i]) ? null : ch));
        results = GP.words.wordHunt(cells, L.cols, st.maxLen);
        renderSide();
        flow.reset();
      }, (e) => GP.toast(e.message, 'error'));
    }

    function toggleUsed(word) {
      if (used.has(word)) used.delete(word); else used.add(word);
      st.used = [...used];
      save();
      if (listEl) listEl.sync();
      flow.render();
    }

    function renderSide(filledCount) {
      GP.clear(side);
      listEl = null;
      const L = LAYOUTS[st.layout];
      side.appendChild(h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', null, 'Order'),
          GP.segmented([{ value: 'score', label: 'Most points' }, { value: 'route', label: 'Smooth route' }], st.order, (v) => { st.order = v; save(); flow.reset(); })),
        h('div', { class: 'field' }, h('label', null, 'Longest word'),
          GP.segmented([6, 8, 10, 12].map((n) => ({ value: n, label: n === 12 ? 'Any' : String(n) })), st.maxLen, (v) => { st.maxLen = v; save(); solve(); }))));

      if (filledCount != null) {
        const total = L.maskArr ? L.maskArr.filter(Boolean).length : L.count;
        side.appendChild(h('div', { class: 'card empty-card' },
          h('p', null, filledCount ? `${filledCount} of ${total} letters in.` : 'Type the letters from your board, or use a screenshot. Words show up once every tile is filled.')));
        return;
      }
      const cur = flow.current();
      listEl = GP.wordResults({
        items: results, used, selected: cur && cur.word,
        onSelect: (x) => flow.select(x), onToggleUsed: toggleUsed,
        query, onQuery: (q) => (query = q),
        emptyText: 'No words found on this board.',
      });
      side.appendChild(h('div', { class: 'card grow' }, listEl));
    }

    /*
     * "Smooth route": after each word, prefer a high-value word that starts
     * near where your finger just stopped, so you spend less time moving.
     */
    let routeCache = null;
    function ordered() {
      if (st.order !== 'route') return results;
      if (routeCache && routeCache.src === results) return routeCache.list;
      const L = LAYOUTS[st.layout];
      const pos = (i) => [Math.floor(i / L.cols), i % L.cols];
      const left = results.slice(0, 120), out = [];
      let at = null;
      while (left.length) {
        let bi = 0, bv = -Infinity;
        left.forEach((x, k) => {
          const [r, c] = pos(x.path[0]);
          const dist = at ? Math.hypot(r - at[0], c - at[1]) : 0;
          const v = x.score / (1 + 0.35 * dist);
          if (v > bv) { bv = v; bi = k; }
        });
        const pickW = left.splice(bi, 1)[0];
        out.push(pickW);
        at = pos(pickW.path[pickW.path.length - 1]);
      }
      const list = out.concat(results.slice(120));
      routeCache = { src: results, list };
      return list;
    }

    function drawPath() {
      GP.clear(overlay);
      if (!tiles) return;
      tiles.inputs.forEach((inp) => { if (inp) { inp.parentElement.classList.remove('on-path', 'start'); inp.parentElement.removeAttribute('data-step'); } });
      const selected = flow.current();
      if (!selected || !results.includes(selected)) return;
      const box = stage.getBoundingClientRect();
      let size = 0;
      const pts = selected.path.map((i, k) => {
        const inp = tiles.inputs[i], wrap = inp.parentElement;
        wrap.classList.add('on-path');
        if (k === 0) wrap.classList.add('start');
        wrap.dataset.step = k + 1;
        const r = inp.getBoundingClientRect();
        size = r.width;
        return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
      });
      overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      // One short arrow between each pair of tiles, stopping short of the
      // letters so they stay readable.
      const trim = size * 0.34, f = (n) => n.toFixed(1);
      overlay.appendChild(h('svg:defs', null, h('svg:marker', { id: 'wh-arrow', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 3, markerHeight: 3, orient: 'auto' },
        h('svg:path', { d: 'M0 0 L10 5 L0 10 z', class: 'wh-head' }))));
      for (let k = 1; k < pts.length; k++) {
        const [x1, y1] = pts[k - 1], [x2, y2] = pts[k];
        const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
        overlay.appendChild(h('svg:path', {
          d: 'M' + f(x1 + ux * trim) + ' ' + f(y1 + uy * trim) + ' L' + f(x2 - ux * trim) + ' ' + f(y2 - uy * trim),
          class: 'wh-line', 'marker-end': 'url(#wh-arrow)', style: { animationDelay: (k - 1) * 40 + 'ms' },
        }));
      }
    }

    function clearBoard() {
      const before = (st.letters[st.layout] || []).slice();
      if (before.some(Boolean)) GP.toast('Board cleared', null, { label: 'Undo', onclick: () => { st.letters[st.layout] = before; save(); buildBoard(); solve(); } });
      st.letters[st.layout] = [];
      save();
      buildBoard();
      solve();
      tiles.focusFirstEmpty();
    }

    const onResize = GP.debounce(drawPath, 100);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', flow.onKey);

    buildBoard();
    solve();
    if (!letters().some(Boolean)) setTimeout(() => tiles.focusFirstEmpty(), 60);

    return { destroy() { window.removeEventListener('resize', onResize); document.removeEventListener('keydown', flow.onKey); } };
  }

  GP.registerGame({
    id: 'wordhunt',
    name: 'Word Hunt',
    tagline: 'Every word, and how to swipe it',
    category: 'word',
    color: '#e0a100',
    help: `<p>Connect touching letters (diagonals count) to make words. Each tile once per word. Longer words score a lot more.</p>
      <ul><li>Type the letters, or tap <b>Screenshot</b> and pick a screenshot of your board.</li>
      <li>The best word shows under the board: start on the green tile and follow the arrows.</li>
      <li>Swiped it in GamePigeon? Tap <b>Next word</b>. <b>Skip</b> moves on without crossing it off.</li>
      <li>Tap any word in the list to show it instead.</li></ul>`,
    mount,
  });
})();
