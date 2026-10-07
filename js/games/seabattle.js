/* Sea Battle: a heat map of where the enemy ships most likely are. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const SB = GP.seabattle;
  const { UNKNOWN, MISS, HIT, SUNK } = SB;

  function fresh(size) {
    return { size, cells: new Array(size * size).fill(UNKNOWN), remaining: Object.assign({}, SB.FLEETS[size]) };
  }

  function mount(root) {
    const st = Object.assign(fresh(10), { heat: true, numbers: false, undo: [] }, GP.store.get('seabattle', {}));
    const save = () => GP.store.set('seabattle', st);
    const boardHost = h('div', { class: 'sb-host' });
    const side = h('div', { class: 'wh-side' });
    const statusEl = h('div', { class: 'status' });
    let popover = null;

    root.appendChild(h('div', { class: 'game-layout' },
      h('section', { class: 'play-area' }, statusEl, boardHost,
        h('div', { class: 'btn-row' },
          GP.button('Undo', { icon: 'undo', onclick: undo, title: 'Undo (Ctrl+Z)' }),
          GP.button('New game', { icon: 'refresh', kind: 'primary', onclick: () => newGame(st.size) }))),
      h('aside', { class: 'panel' }, side)));

    const col = (i) => GP.letters[i % st.size] + (Math.floor(i / st.size) + 1);

    function remember() {
      st.undo.push({ cells: st.cells.slice(), remaining: Object.assign({}, st.remaining) });
      if (st.undo.length > 200) st.undo.shift();
    }
    function undo() {
      const prev = st.undo.pop();
      if (!prev) return;
      st.cells = prev.cells;
      st.remaining = prev.remaining;
      GP.sound.play('click');
      save();
      render();
    }
    function newGame(size) {
      const before = JSON.parse(JSON.stringify({ size: st.size, cells: st.cells, remaining: st.remaining, undo: st.undo }));
      const had = st.cells.some((v) => v !== UNKNOWN);
      Object.assign(st, fresh(size), { undo: [] });
      save();
      render();
      if (had) GP.toast('New game', null, { label: 'Undo', onclick: () => { Object.assign(st, before); save(); render(); } });
    }

    function mark(i, state) {
      closePopover();
      remember();
      if (state === SUNK) {
        st.cells[i] = HIT;
        const group = SB.groups(st.size, st.cells, HIT).find((g) => g.includes(i));
        group.forEach((k) => (st.cells[k] = SUNK));
        const len = group.length;
        if (st.remaining[len] > 0) {
          st.remaining[len]--;
          GP.toast('Sunk a ' + len + '-long ship!', 'good');
        } else GP.toast('No ' + len + '-long ships left in the fleet list. Check the counts.', 'warn');
        GP.sound.play('boom');
        GP.buzz(40);
        if (Object.values(st.remaining).every((n) => n === 0)) setTimeout(() => { GP.confetti(); GP.sound.play('win'); }, 350);
      } else {
        st.cells[i] = state;
        GP.sound.play(state === MISS ? 'splash' : state === HIT ? 'boom' : 'click');
      }
      save();
      render();
    }

    function closePopover() {
      if (popover) { popover.remove(); popover = null; }
    }
    function openPopover(i, cellEl) {
      closePopover();
      const v = st.cells[i];
      const opt = (label, state, cls) => h('button', { type: 'button', class: 'pop-opt ' + cls, onclick: (e) => { e.stopPropagation(); mark(i, state); } }, h('i'), label);
      popover = h('div', { class: 'sb-pop', role: 'menu' },
        h('div', { class: 'pop-title' }, col(i)),
        v !== MISS ? opt('Miss', MISS, 'miss') : null,
        v !== HIT ? opt('Hit', HIT, 'hit') : null,
        opt('Sunk', SUNK, 'sunk'),
        v !== UNKNOWN ? opt('Clear', UNKNOWN, 'clear') : null);
      const host = boardHost.getBoundingClientRect(), r = cellEl.getBoundingClientRect();
      popover.style.left = Math.min(Math.max(4, r.left - host.left + r.width / 2 - 70), host.width - 144) + 'px';
      popover.style.top = r.bottom - host.top + 6 + 'px';
      boardHost.appendChild(popover);
      GP.sound.play('click');
    }

    const simCache = { key: null, val: null };
    function render() {
      closePopover();
      const n = st.size;
      // While hunting (no open hits) the counting method is smooth and exact enough;
      // once there are hits, simulated fleets give sharper chances.
      const hasHit = st.cells.some((v) => v === HIT);
      // Simulations are random, so keep the result for the same board: the
      // stars shouldn't move around when nothing changed.
      const simKey = n + ':' + st.cells.join('') + JSON.stringify(st.remaining);
      if (simCache.key !== simKey) {
        simCache.key = simKey;
        simCache.val = hasHit && Object.values(st.remaining).some((x) => x > 0) ? SB.simulate(n, st.cells, st.remaining, 160) : null;
      }
      const sim = simCache.val;
      let a;
      if (sim) a = { score: sim.prob, max: sim.max, best: sim.best, blocked: sim.blocked };
      else {
        // Turn counting scores into chances: spread the remaining ship squares over the board.
        a = SB.analyze(n, st.cells, st.remaining);
        const shipCells = Object.keys(st.remaining).reduce((t, len) => t + len * st.remaining[len], 0);
        let sum = 0;
        for (let i = 0; i < n * n; i++) if (st.cells[i] === UNKNOWN) sum += a.score[i];
        const prob = new Float64Array(n * n);
        for (let i = 0; i < n * n; i++) prob[i] = sum ? Math.min(1, (a.score[i] * shipCells) / sum) : 0;
        a = { score: prob, max: sum ? Math.min(1, (a.max * shipCells) / sum) : 0, best: a.best, blocked: a.blocked };
      }
      const best = new Set(a.best);
      // Stretch the colors between the weakest and strongest open cells so differences stand out.
      let min = Infinity;
      for (let i = 0; i < n * n; i++) if (st.cells[i] === UNKNOWN && !a.blocked[i] && a.score[i] > 0) min = Math.min(min, a.score[i]);
      const range = a.max - min;
      GP.clear(boardHost);

      const grid = h('div', { class: 'sb-grid', style: { gridTemplateColumns: `1.4em repeat(${n}, 1fr)` } });
      grid.appendChild(h('span'));
      for (let c = 0; c < n; c++) grid.appendChild(h('span', { class: 'sb-coord' }, GP.letters[c]));
      for (let r = 0; r < n; r++) {
        grid.appendChild(h('span', { class: 'sb-coord' }, r + 1));
        for (let c = 0; c < n; c++) {
          const i = r * n + c, v = st.cells[i];
          const rel = v === UNKNOWN && a.max ? (range > 0 ? (a.score[i] - min) / range : 1) : 0;
          const heat = a.score[i] > 0 ? 0.08 + 0.92 * Math.pow(Math.max(0, rel), 1.6) : 0;
          const cls = ['sb-cell', ['unknown', 'miss', 'hit', 'sunk'][v]];
          if (v === UNKNOWN && a.blocked[i]) cls.push('blocked');
          if (best.has(i)) cls.push('best');
          const cell = h('button', {
            type: 'button', class: cls.join(' '), 'aria-label': col(i),
            style: st.heat && heat > 0 ? { '--heat': heat.toFixed(3) } : null,
            onclick: (e) => { e.stopPropagation(); openPopover(i, cell); },
          });
          if (st.heat && st.numbers && v === UNKNOWN && !a.blocked[i]) cell.appendChild(h('small', null, Math.round(a.score[i] * 100) + '%'));
          grid.appendChild(cell);
        }
      }
      boardHost.appendChild(grid);

      // Status line
      GP.clear(statusEl);
      const shots = st.cells.filter((v) => v !== UNKNOWN).length;
      const done = Object.values(st.remaining).every((x) => x === 0);
      statusEl.className = 'status' + (done ? ' win' : '');
      statusEl.appendChild(GP.icon('target'));
      statusEl.appendChild(h('span', { class: 'status-text' }, done
        ? 'Fleet destroyed! You win.'
        : a.best.length ? 'Best shot: ' + (a.best.length > 2 ? 'any star' : a.best.map(col).join(' or '))
          + ' (' + Math.round(a.max * 100) + '%)' : 'Tap a square after each shot'));

      // Side panel
      GP.clear(side);
      const hits = st.cells.filter((v) => v === HIT || v === SUNK).length;
      side.appendChild(h('div', { class: 'card' }, h('h3', null, 'How to use'),
        h('p', { class: 'hint-text' }, 'Fire at a square with a star in GamePigeon. Then tap that square here and pick what happened. When a ship sinks, tap one of its squares and pick ', h('b', null, 'Sunk'), '.')));

      const fleet = h('div', { class: 'fleet' });
      Object.keys(SB.FLEETS[n]).map(Number).sort((x, y) => y - x).forEach((len) => {
        const left = st.remaining[len] || 0, total = SB.FLEETS[n][len];
        fleet.appendChild(h('div', { class: 'fleet-row' },
          h('span', { class: 'ship' }, Array.from({ length: len }, () => h('i'))),
          h('span', { class: 'fleet-count' }, left + ' of ' + total + ' left'),
          h('span', { class: 'stepper' },
            GP.button('', { icon: 'prev', kind: 'ghost', title: 'One fewer', disabled: left <= 0, onclick: () => { remember(); st.remaining[len] = left - 1; save(); render(); } }),
            GP.button('', { icon: 'next', kind: 'ghost', title: 'One more', disabled: left >= total, onclick: () => { remember(); st.remaining[len] = left + 1; save(); render(); } }))));
      });
      side.appendChild(h('div', { class: 'card' }, h('h3', null, 'Their ships'), fleet,
        h('div', { class: 'stats-row' },
          h('div', null, h('b', null, shots), h('small', null, 'shots')),
          h('div', null, h('b', null, hits), h('small', null, 'hits')),
          h('div', null, h('b', null, shots ? Math.round((hits / shots) * 100) + '%' : '-'), h('small', null, 'accuracy')))));

      side.appendChild(h('div', { class: 'card' }, h('h3', null, 'Board'),
        h('div', { class: 'field' }, h('label', null, 'Size'),
          GP.segmented([8, 9, 10].map((x) => ({ value: x, label: x + ' × ' + x })), st.size, (v) => { newGame(v); setTimeout(render, 0); })),
        GP.toggle('Heat map', st.heat, (v) => { st.heat = v; save(); render(); }, 'Brighter means more likely to hide a ship'),
        GP.toggle('Show chances', st.numbers, (v) => { st.numbers = v; save(); render(); }, 'The chance each square hides a ship')));
    }

    const onDoc = (e) => { if (popover && !popover.contains(e.target)) closePopover(); };
    const onKey = (e) => {
      if (e.key === 'Escape') closePopover();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    render();
    return { destroy() { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); } };
  }

  GP.registerGame({
    id: 'seabattle',
    name: 'Sea Battle',
    tagline: 'Know where to fire next',
    category: 'board',
    color: '#0e8fd6',
    help: `<p>Like Battleship. Ships are straight, 1 to 4 squares long, and never touch, not even at the corners.</p>
      <ul><li>Fire at the square with the star. Then tap that square here and pick <b>Miss</b>, <b>Hit</b> or <b>Sunk</b>.</li>
      <li>Brighter squares are more likely to hide a ship. Turn on <b>Show chances</b> to see the numbers.</li>
      <li>Board sizes and ships match GamePigeon's 8×8, 9×9 and 10×10 games.</li></ul>`,
    mount,
  });
})();
