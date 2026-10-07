/* Filler */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.filler;
  // Close to GamePigeon's palette.
  const COLORS = ['#e64553', '#8ccf4d', '#fad140', '#4aa7ea', '#6c4bb4', '#454545'];
  const NAMES = ['Red', 'Green', 'Yellow', 'Blue', 'Purple', 'Black'];

  function render(host, v) {
    const s = v.state, me = v.me;
    GP.clear(host);
    const cnt = [0, 0];
    s.own.forEach((o) => { if (o >= 0) cnt[o]++; });
    // Your corner is always bottom-left, as in GamePigeon: flip the board when you're player 1.
    const flip = me === 1;
    const grid = h('div', { class: 'fl', style: { gridTemplateColumns: `repeat(${s.w}, 1fr)` } });
    for (let rr = 0; rr < s.h; rr++) for (let cc = 0; cc < s.w; cc++) {
      const r = flip ? s.h - 1 - rr : rr, c = flip ? s.w - 1 - cc : cc, i = r * s.w + c;
      const o = s.own[i];
      const cell = h('button', {
        type: 'button', class: 'fl-cell' + (o >= 0 ? ' own p' + (o === me ? 'me' : 'op') : ''),
        style: { background: COLORS[s.col[i]] }, 'aria-label': NAMES[s.col[i]],
        onclick: v.editing ? () => v.onEdit(i) : null,
      });
      if (i === E.start(s.w, s.h, 0) || i === E.start(s.w, s.h, 1)) cell.appendChild(h('i', { class: 'fl-home' }, i === E.start(s.w, s.h, me) ? 'You' : 'Opp'));
      grid.appendChild(cell);
    }
    // Color buttons for the side to move.
    const legal = new Set(v.legal);
    const picker = h('div', { class: 'fl-pick' });
    COLORS.forEach((col, k) => {
      const ok = legal.has(k) && v.canPlay;
      const gain = legal.has(k) ? E.gain(s, k) : 0;
      picker.appendChild(h('button', {
        type: 'button', class: 'fl-color' + (v.hint && v.hint.move === k ? ' hint' : ''), disabled: !ok || null,
        style: { background: col }, 'aria-label': NAMES[k], onclick: () => v.onMove(k),
      }, legal.has(k) ? h('b', null, '+' + gain) : null));
    });
    host.append(
      h('div', { class: 'oth-score' },
        h('span', { class: 'chip' }, 'You ', h('b', null, cnt[me])),
        h('span', { class: 'chip' }, 'Them ', h('b', null, cnt[1 - me])),
        h('span', { class: 'chip muted' }, (s.w * s.h / 2 + 1 | 0) + ' to win')),
      h('div', { class: 'fl-wrap' }, grid),
      v.editing ? null : picker);
  }

  function recount(s) { return E.withOwners(s.w, s.h, s.col, s.turn); }

  const cfg = {
    id: 'filler',
    engine: 'filler',
    sides: [{ name: 'Bottom-left', color: '#8ccf4d' }, { name: 'Top-right', color: '#e64553' }],
    swatch: (p) => GP.pieceSwatch('flp' + p),
    moveLabel: (k) => NAMES[k],
    evalScale: 500,
    evalUnit: 100,
    render,
    explain: (s, k) => 'grabs ' + GP.plural(E.gain(s, k), 'cell') + ' now',
    options: [{ key: 'size', label: 'Board', default: '8x7', choices: [{ value: '8x7', label: '8 × 7' }, { value: '10x9', label: '10 × 9' }] }],
    resultText: (res) => '(' + res.counts[0] + ' to ' + res.counts[1] + ')',
    editTools: COLORS.map((c, k) => ({ value: k, label: NAMES[k], swatch: c })),
    edit(s, i, tool) {
      const col = s.col.slice();
      col[i] = tool;
      return recount(Object.assign({}, s, { col }));
    },
    clearBoard: (fresh) => fresh,
    extraEdit: (game) => GP.button('From screenshot', { icon: 'upload', kind: 'ghost', onclick: () => {
      const s = game.state;
      GP.gridFromImage({
        rows: s.h, cols: s.w, title: 'Read the Filler board',
        help: 'Drag the corners so the grid lines up with the colored squares.',
        read: (samples) => {
          const col = samples.map((rgb) => nearest(rgb));
          game.commitEdit(recount(Object.assign({}, s, { col })));
          GP.toast('Board loaded. Check the colors and fix any with the paint tools.', 'good');
        },
      });
    } }),
    initialOptions: {},
  };

  function nearest(rgb) {
    let best = 0, bd = Infinity;
    COLORS.forEach((hex, k) => {
      const c = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
      const d = (c[0] - rgb[0]) ** 2 * 2 + (c[1] - rgb[1]) ** 2 * 4 + (c[2] - rgb[2]) ** 2 * 3;
      if (d < bd) { bd = d; best = k; }
    });
    return best;
  }

  GP.registerGame({
    id: 'filler',
    name: 'Filler',
    tagline: 'Pick colors, grab the board',
    category: 'board',
    color: '#26a69a',
    help: `<p>You start bottom left, they start top right. Each turn, pick a color: your area turns that color and takes every touching square of it. Own more than half to win.</p>
      <ul><li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>Each color shows how many squares it takes right now. The best pick looks many turns ahead.</li>
      <li>To copy a real game, tap <b>Edit</b>, then <b>From screenshot</b>.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();
