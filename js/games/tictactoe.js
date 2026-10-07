/* Tic Tac Toe */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;

  function mark(p, fresh) {
    const cls = 'ttt-mark' + (fresh ? ' draw-in' : '');
    if (p === 0) {
      return h('svg:svg', { viewBox: '0 0 100 100', class: cls + ' x' },
        h('svg:path', { d: 'M22 22 L78 78', pathLength: 1 }), h('svg:path', { d: 'M78 22 L22 78', pathLength: 1 }));
    }
    return h('svg:svg', { viewBox: '0 0 100 100', class: cls + ' o' }, h('svg:circle', { cx: 50, cy: 50, r: 29, pathLength: 1 }));
  }

  function verdict(score) {
    if (score >= GP.DECISIVE) return ['good', 'Win'];
    if (score <= -GP.DECISIVE) return ['bad', 'Lose'];
    return ['mid', 'Tie'];
  }

  function render(host, v) {
    const s = v.state;
    GP.clear(host);
    const legal = new Set(v.legal);
    const win = new Set(v.result && v.result.line ? v.result.line : []);
    const grid = h('div', { class: 'ttt' });
    for (let i = 0; i < 9; i++) {
      const p = s.b[i];
      const cell = h('button', {
        type: 'button',
        class: 'ttt-cell' + (win.has(i) ? ' win' : '') + (v.hint && v.hint.move === i ? ' hint' : ''),
        'aria-label': 'Square ' + (i + 1),
        onclick: v.editing ? () => v.onEdit(i) : legal.has(i) && v.canPlay ? () => v.onMove(i) : null,
      });
      if (p >= 0) cell.appendChild(mark(p, v.animate && v.animate.move === i));
      else if (v.hint && v.hint.scores && v.hint.scores[i] != null) {
        const [cls, text] = verdict(v.hint.scores[i]);
        cell.appendChild(h('span', { class: 'ttt-verdict ' + cls }, text));
      }
      grid.appendChild(cell);
    }
    host.appendChild(grid);
  }

  const cfg = {
    id: 'tictactoe',
    engine: 'tictactoe',
    sides: [{ name: 'X', color: '#ff4f93' }, { name: 'O', color: '#2f7bff' }],
    swatch: (p) => h('i', { class: 'piece-swatch tttp' + p }, p ? 'O' : 'X'),
    moveLabel: (m) => ['Top left', 'Top', 'Top right', 'Left', 'Center', 'Right', 'Bottom left', 'Bottom', 'Bottom right'][m],
    render,
    explain: GP.explainPlacement,
    editTools: [
      { value: 0, label: 'X', swatch: '#ff4f93' },
      { value: 1, label: 'O', swatch: '#2f7bff' },
      { value: -1, label: 'Erase' },
    ],
    edit(s, i, tool) {
      const b = s.b.slice();
      b[i] = b[i] === tool ? -1 : tool;
      return Object.assign({}, s, { b, last: -1 });
    },
    onKey(game, e) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9) game.play(n - 1);
    },
  };

  GP.registerGame({
    id: 'tictactoe',
    name: 'Tic Tac Toe',
    tagline: 'The bot never loses',
    category: 'board',
    color: '#ff4f93',
    help: `<p>Get three in a row. The bot plays perfectly, so the best you can do against it is a tie.</p>
      <ul><li>Empty squares are labeled <b>Win</b>, <b>Tie</b> or <b>Lose</b> for you.</li>
      <li>Keys 1 to 9 pick squares, left to right, top to bottom.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();
