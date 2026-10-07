/* Chess, coached by Stockfish. */
(function () {
  'use strict';
  const GP = window.GP, h = GP.h;
  const E = GP.engines.chess;
  const FILES = 'abcdefgh';
  // Solid glyphs for both colors; U+FE0E asks for text style instead of emoji.
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  E.asyncSearch = (s, level, purpose) => GP.stockfish.search(E.fenOf(s), level, purpose === 'analyze' ? 3 : 1);

  const sq = (r, c) => FILES[c] + (8 - r);
  const piece = (p, extra) => h('span', { class: 'cp ' + (p.color === 'w' ? 'white' : 'black') + (extra ? ' ' + extra : '') }, GLYPH[p.type] + '︎');

  // Selection lives outside the render so it survives redraws of the same position.
  let sel = null, selFen = null;
  // While a piece is being dragged, redraws wait until it's dropped.
  let drag = null, pending = null;

  function render(host, v) {
    if (drag) { pending = { host, v }; return; }
    const s = v.state, g = E.game(s);
    GP.clear(host);
    if (!g) { host.appendChild(h('p', { class: 'empty' }, 'This position is not valid. Use Edit to fix it.')); return; }
    if (selFen !== s.fen + s.turn) { sel = null; selFen = s.fen + s.turn; }
    const board = g.board();
    const flip = v.me === 1;
    const legal = v.legal;
    const dests = sel ? legal.filter((m) => m.startsWith(sel)).map((m) => m.slice(2, 4)) : [];
    const last = s.last ? [s.last.slice(0, 2), s.last.slice(2, 4)] : [];
    const hint = v.hint && typeof v.hint.move === 'string' ? [v.hint.move.slice(0, 2), v.hint.move.slice(2, 4)] : [];
    const checkSq = g.in_check() ? findKing(board, g.turn()) : null;

    const grid = h('div', { class: 'chess no-swipe' + (flip ? ' flipped' : '') });
    for (let rr = 0; rr < 8; rr++) {
      for (let cc = 0; cc < 8; cc++) {
        const r = flip ? 7 - rr : rr, c = flip ? 7 - cc : cc;
        const name = sq(r, c), p = board[r][c];
        const cls = ['csq', (r + c) % 2 ? 'dark' : 'light'];
        if (last.includes(name)) cls.push('last');
        if (hint.includes(name)) cls.push('hint');
        if (name === sel) cls.push('sel');
        if (dests.includes(name)) cls.push(p ? 'capture' : 'dest');
        if (name === checkSq) cls.push('check');
        const cell = h('button', { type: 'button', class: cls.join(' '), 'aria-label': name + (p ? ' ' + (p.color === 'w' ? 'white ' : 'black ') + NAMES[p.type] : ''),
          dataset: { sq: name },
          // Keyboard users (Enter/Space) still get a click; pointers are handled by the board.
          onclick: (e) => { if (e.detail === 0) click(v, name, p, g); } });
        if (p) cell.appendChild(piece(p, v.animate && s.last && s.last.slice(2, 4) === name ? 'pop' : ''));
        if (cc === 0) cell.appendChild(h('i', { class: 'rank' }, 8 - r));
        if (rr === 7) cell.appendChild(h('i', { class: 'file' }, FILES[c]));
        grid.appendChild(cell);
      }
    }
    const wrap = h('div', { class: 'chess-wrap' }, grid);
    bindPointer(grid, wrap, v, g, board, flip);
    if (hint.length) wrap.appendChild(arrow(hint[0], hint[1], flip));
    host.appendChild(capturedBar(g, 1 - v.me));
    host.appendChild(wrap);
    host.appendChild(capturedBar(g, v.me));
  }

  function findKing(board, color) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === 'k' && p.color === color) return sq(r, c);
    }
    return null;
  }

  /* Pieces a side has captured, and the material balance. */
  function capturedBar(g, side) {
    const color = side === 0 ? 'w' : 'b', other = color === 'w' ? 'b' : 'w';
    const full = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const count = { w: {}, b: {} };
    g.board().forEach((row) => row.forEach((p) => { if (p) count[p.color][p.type] = (count[p.color][p.type] || 0) + 1; }));
    const took = [];
    let mat = 0;
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const n = Math.max(0, full[t] - (count[other][t] || 0));
      for (let k = 0; k < n; k++) took.push(piece({ type: t, color: other }, 'mini'));
      mat += (count[color][t] || 0) * VALUES[t] - (count[other][t] || 0) * VALUES[t];
    }
    return h('div', { class: 'captured' }, took, mat > 0 ? h('b', null, '+' + mat) : null);
  }

  function arrow(from, to, flip) {
    const pos = (name) => {
      let c = FILES.indexOf(name[0]), r = 8 - +name[1];
      if (flip) { c = 7 - c; r = 7 - r; }
      return [c + 0.5, r + 0.5];
    };
    const [x1, y1] = pos(from), [x2, y2] = pos(to);
    const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const ex = x2 - ux * 0.3, ey = y2 - uy * 0.3;
    return h('svg:svg', { class: 'chess-arrow', viewBox: '0 0 8 8', 'aria-hidden': 'true' },
      h('svg:line', { x1: x1 + ux * 0.2, y1: y1 + uy * 0.2, x2: ex, y2: ey }),
      h('svg:polygon', { points: `${x2},${y2} ${ex - uy * 0.25},${ey + ux * 0.25} ${ex + uy * 0.25},${ey - ux * 0.25}` }));
  }

  function click(v, name, p, g) {
    if (v.editing) { v.onEdit(name); return; }
    if (!v.canPlay) return;
    const legal = v.legal;
    if (sel) {
      const opts = legal.filter((m) => m.startsWith(sel + name));
      if (opts.length === 1) { const m = opts[0]; sel = null; v.onMove(m); return; }
      if (opts.length > 1) { promote(opts, v, name, null, v.me === 1); return; }
    }
    const turn = g.turn();
    if (p && p.color === turn && legal.some((m) => m.startsWith(name))) { sel = name; GP.sound.play('click'); }
    else sel = null;
    v.game.renderBoard();
  }

  /*
   * Tap a piece then a square, or drag the piece. One pointer handler covers
   * mouse, finger and pen: a short press is a tap, anything else a drag.
   */
  function bindPointer(grid, wrap, v, g, board, flip) {
    // Any board square under the pointer (the board may have been redrawn meanwhile).
    const at = (x, y) => { const el = document.elementFromPoint(x, y); const c = el && el.closest('.chess .csq'); return c ? c.dataset.sq : null; };
    const pieceAt = (name) => { const r = 8 - +name[1], c = FILES.indexOf(name[0]); return board[r][c]; };
    grid.addEventListener('pointerdown', (e) => {
      if (drag) return;
      const from = at(e.clientX, e.clientY);
      if (!from) return;
      const p = pieceAt(from);
      const canDrag = !v.editing && v.canPlay && p && p.color === g.turn() && v.legal.some((m) => m.startsWith(from));
      e.preventDefault();
      // Listen on the whole window, so a drag never gets lost if the board redraws.
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from, ghost: null };
      const move = (ev) => {
        if (ev.pointerId !== drag.id || !canDrag) return;
        if (!drag.ghost && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return;
        if (!drag.ghost) {
          // Lift the piece: show where it can go and follow the pointer.
          sel = from;
          const cell = grid.querySelector('[data-sq="' + from + '"]');
          const size = cell.getBoundingClientRect().width;
          const dests = v.legal.filter((m) => m.startsWith(from)).map((m) => m.slice(2, 4));
          grid.querySelectorAll('.csq').forEach((c) => {
            if (dests.includes(c.dataset.sq)) c.classList.add(pieceAt(c.dataset.sq) ? 'capture' : 'dest');
          });
          cell.classList.add('sel', 'lifted');
          drag.ghost = document.body.appendChild(h('span', { class: 'drag-piece', style: { width: size + 'px', height: size + 'px' } }, piece(p)));
        }
        drag.ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
      };
      const end = (ev) => {
        if (ev.pointerId !== drag.id) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        const d = drag;
        drag = null;
        document.querySelectorAll('.drag-piece').forEach((x) => x.remove());
        const redraw = () => { const pend = pending; pending = null; if (pend) render(pend.host, pend.v); else v.game.renderBoard(); };
        if (!d.ghost) {
          if (ev.type === 'pointerup') click(v, from, p, g); // a tap
          else redraw();
          return;
        }
        const to = ev.type === 'pointerup' ? at(ev.clientX, ev.clientY) : null;
        const opts = to && to !== from ? v.legal.filter((m) => m.startsWith(from + to)) : [];
        if (opts.length === 1) { sel = null; pending = null; v.onMove(opts[0]); return; }
        if (opts.length > 1) { pending = null; promote(opts, v, to, GP.$('.chess-wrap') || wrap, flip); return; }
        sel = to === from ? from : null;
        redraw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
    });
  }

  /* A small menu next to the promotion square: queen, rook, bishop or knight. */
  function promote(opts, v, to, wrap, flip) {
    wrap = wrap || GP.$('.chess-wrap');
    to = to || opts[0].slice(2, 4);
    const color = v.state.turn === 0 ? 'w' : 'b';
    let c = FILES.indexOf(to[0]), r = 8 - +to[1];
    if (flip) { c = 7 - c; r = 7 - r; }
    // Open downward from a top square, upward from a bottom one.
    const place = r < 4 ? { top: (r / 8) * 100 + '%' } : { bottom: ((7 - r) / 8) * 100 + '%' };
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e) => { if (!menu.contains(e.target)) { close(); sel = null; v.game.renderBoard(); } };
    const menu = h('div', { class: 'promo', role: 'menu', style: Object.assign({ left: (c / 8) * 100 + '%' }, place) }, ['q', 'r', 'b', 'n'].map((t) => h('button', {
      type: 'button', class: 'promo-btn', title: NAMES[t], 'aria-label': 'Promote to ' + NAMES[t],
      onclick: () => { close(); sel = null; v.onMove(opts.find((x) => x[4] === t)); },
    }, piece({ type: t, color }))));
    wrap.appendChild(menu);
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }

  /* Board editor: place any piece, keeping castling rights consistent. */
  function edit(s, name, tool) {
    const g = E.game(s) || new window.Chess();
    const rows = g.board().map((row) => row.map((p) => (p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : null)));
    const r = 8 - +name[1], c = FILES.indexOf(name[0]);
    rows[r][c] = tool === 'x' || rows[r][c] === tool ? null : tool;
    const place = rows.map((row) => {
      let out = '', gap = 0;
      for (const x of row) { if (!x) gap++; else { if (gap) out += gap; gap = 0; out += x; } }
      return out + (gap ? gap : '');
    }).join('/');
    let castle = '';
    const at = (rr, cc) => rows[rr][cc];
    if (at(7, 4) === 'K' && at(7, 7) === 'R') castle += 'K';
    if (at(7, 4) === 'K' && at(7, 0) === 'R') castle += 'Q';
    if (at(0, 4) === 'k' && at(0, 7) === 'r') castle += 'k';
    if (at(0, 4) === 'k' && at(0, 0) === 'r') castle += 'q';
    const fen = [place, s.turn ? 'b' : 'w', castle || '-', '-', 0, 1].join(' ');
    return { fen, turn: s.turn, reps: [], last: null };
  }

  const TOOLS = [];
  for (const color of ['w', 'b']) for (const t of ['k', 'q', 'r', 'b', 'n', 'p']) {
    TOOLS.push({ value: color === 'w' ? t.toUpperCase() : t, label: GLYPH[t] + '︎', cls: color === 'w' ? 'white' : 'black' });
  }
  TOOLS.push({ value: 'x', label: 'Erase' });

  const cfg = {
    id: 'chess',
    engine: 'chess',
    sides: [{ name: 'White', color: '#f4f4f4' }, { name: 'Black', color: '#1b1b1f' }],
    swatch: (p) => GP.pieceSwatch('othp' + (1 - p)),
    fixedFirst: true,
    moveLabel: (m, s) => E.san(s, m),
    evalScale: 350,
    evalUnit: 100,
    render,
    onPlayed: (game, m, from, to) => {
      const g = E.game(to);
      GP.sound.play(g && g.in_check() ? 'hint' : to.san && to.san.includes('x') ? 'flip' : 'place');
    },
    explain(s, m) {
      const g = E.game(s);
      const mv = g && g.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] || 'q' });
      if (!mv) return null;
      if (g.in_checkmate()) return 'checkmate!';
      const bits = [];
      if (mv.captured) bits.push('takes a ' + NAMES[mv.captured]);
      if (mv.promotion) bits.push('promotes to a ' + NAMES[mv.promotion]);
      if (mv.flags.includes('k') || mv.flags.includes('q')) bits.push('castles');
      if (g.in_check()) bits.push('check');
      return bits.join(', ') || null;
    },
    resultText: (res) => '(' + res.reason + ')',
    editTools: TOOLS,
    edit,
    clearBoard: (fresh) => ({ fen: '4k3/8/8/8/8/8/8/4K3 ' + (fresh.turn ? 'b' : 'w') + ' - - 0 1', turn: fresh.turn, reps: [], last: null }),
    extraEdit: (game) => GP.button('Paste FEN', { icon: 'paste', kind: 'ghost', onclick: () => {
      const input = h('input', { class: 'text-input', placeholder: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', spellcheck: 'false' });
      GP.modal('Load a position (FEN)', h('div', null, h('p', { class: 'hint-text' }, 'Paste a FEN string, for example from a chess site.'), input), [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Load', kind: 'primary', onclick: () => {
          const g = new window.Chess();
          const fen = input.value.trim();
          if (!g.load(fen)) { GP.toast('That FEN is not valid', 'error'); return; }
          game.commitEdit({ fen: g.fen(), turn: g.turn() === 'w' ? 0 : 1, reps: [], last: null });
        } },
      ]);
    } }),
  };

  GP.registerGame({
    id: 'chess',
    name: 'Chess',
    tagline: 'Stockfish in your pocket',
    category: 'board',
    color: '#8d6e63',
    help: `<p>Regular chess. Your coach is Stockfish, one of the strongest chess programs there is.</p>
      <ul><li>Drag a piece to move it, or tap it and then tap where it goes.</li>
      <li>Playing a friend? Pick <b>A friend</b>, then tap each move they make. Your best move shows under the board. Turn on <b>Bot moves for me</b> and you only tap theirs.</li>
      <li>The green arrow is the best move.</li>
      <li>Tap <b>Edit</b> to set up any position, or paste a FEN.</li>
      <li>The first time, chess downloads about 7 MB.</li></ul>`,
    mount: (root) => new GP.BoardGame(root, cfg),
  });
})();
