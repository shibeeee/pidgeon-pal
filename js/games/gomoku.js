/* Gomoku (five in a row) */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const COLS = 'ABCDEFGHJKLMNOPQRST'; // "I" is skipped, as on real Go boards

  function label(m, s) {
    const n = s.n;
    return COLS[m % n] + (n - Math.floor(m / n));
  }

  function render(host, v) {
    const s = v.state, n = s.n;
    GP.clear(host);
    const P = 1, S = 1; // 1 unit per cell; padding of one unit for coordinates
    const size = n - 1 + P * 2;
    const svg = h('svg:svg', { viewBox: `0 0 ${size} ${size}`, class: 'gmk', role: 'grid' });
    const at = (i) => [P + (i % n) * S, P + Math.floor(i / n) * S];

    const defs = h('svg:defs', null,
      h('svg:radialGradient', { id: 'gk-b', cx: '35%', cy: '30%', r: '70%' },
        h('svg:stop', { offset: '0%', 'stop-color': '#666' }), h('svg:stop', { offset: '100%', 'stop-color': '#0b0b0d' })),
      h('svg:radialGradient', { id: 'gk-w', cx: '35%', cy: '30%', r: '75%' },
        h('svg:stop', { offset: '0%', 'stop-color': '#fff' }), h('svg:stop', { offset: '100%', 'stop-color': '#cfcfcf' })));
    svg.appendChild(defs);
    svg.appendChild(h('svg:rect', { x: 0, y: 0, width: size, height: size, class: 'gmk-bg', rx: 0.3 }));
    for (let k = 0; k < n; k++) {
      svg.appendChild(h('svg:line', { x1: P, y1: P + k, x2: P + n - 1, y2: P + k, class: 'gmk-line' }));
      svg.appendChild(h('svg:line', { x1: P + k, y1: P, x2: P + k, y2: P + n - 1, class: 'gmk-line' }));
      svg.appendChild(h('svg:text', { x: P + k, y: 0.55, class: 'gmk-coord' }, COLS[k]));
      svg.appendChild(h('svg:text', { x: 0.45, y: P + k + 0.13, class: 'gmk-coord' }, n - k));
    }
    // Star points
    const mid = n >> 1, q = n >= 13 ? 3 : 2;
    for (const [r, c] of [[mid, mid], [q, q], [q, n - 1 - q], [n - 1 - q, q], [n - 1 - q, n - 1 - q]]) {
      svg.appendChild(h('svg:circle', { cx: P + c, cy: P + r, r: 0.1, class: 'gmk-star' }));
    }

    if (v.result && v.result.line) {
      const a = at(v.result.line[0]), b = at(v.result.line[4]);
      svg.appendChild(h('svg:line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'gmk-win' }));
    }

    const legal = new Set(v.legal);
    for (let i = 0; i < n * n; i++) {
      const [x, y] = at(i), p = s.b[i];
      if (p >= 0) {
        const stone = h('svg:circle', { cx: x, cy: y, r: 0.44, fill: p ? 'url(#gk-w)' : 'url(#gk-b)', class: 'stone s' + p + (v.animate && v.animate.move === i ? ' pop' : '') });
        svg.appendChild(stone);
        if (i === s.last) svg.appendChild(h('svg:circle', { cx: x, cy: y, r: 0.12, class: 'gmk-last' }));
      }
      if (v.hint && v.hint.move === i) svg.appendChild(h('svg:circle', { cx: x, cy: y, r: 0.42, class: 'gmk-hint' }));
      const clickable = v.editing || (legal.has(i) && v.canPlay);
      const hit = h('svg:rect', { x: x - 0.5, y: y - 0.5, width: 1, height: 1, class: 'gmk-hit' + (clickable && p < 0 ? ' playable s' + s.turn : '') });
      if (clickable) hit.addEventListener('click', () => (v.editing ? v.onEdit(i) : v.onMove(i)));
      svg.appendChild(hit);
    }
    host.appendChild(h('div', { class: 'gmk-wrap' }, svg));
  }

  const cfg = {
    id: 'gomoku',
    engine: 'gomoku',
    sides: [{ name: 'Black', color: '#1b1b1f' }, { name: 'White', color: '#f4f4f4' }],
    swatch: (p) => GP.pieceSwatch('othp' + p),
    moveLabel: label,
    evalScale: 3000,
    evalUnit: 500,
    options: [{
      key: 'size', label: 'Board size', default: 15,
      choices: [{ value: 11, label: '11' }, { value: 13, label: '13' }, { value: 15, label: '15' }, { value: 19, label: '19' }],
    }],
    render,
    explain: GP.explainPlacement,
    editTools: [
      { value: 0, label: 'Black', swatch: '#1b1b1f' },
      { value: 1, label: 'White', swatch: '#f4f4f4' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      return Object.assign({}, s, { b, last: -1 });
    },
  };

  GP.registerGame({
    id: 'gomoku',
    name: 'Gomoku',
    tagline: 'Five stones in a row',
    category: 'board',
    color: '#c98a3a',
    help: `<p>Take turns placing stones. First to get five in a row wins. Black goes first.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Joining a game already going? Tap <b>Edit</b> and copy the board.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();
