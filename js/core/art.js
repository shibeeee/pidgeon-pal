/*
 * Flat SVG illustrations for the game cards (viewBox 160 x 100): simple
 * shapes, flat colors, no shine. Each one is a tiny version of the board.
 */
(function () {
  'use strict';
  const GP = window.GP;
  const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,system-ui,sans-serif';

  // A letter tile.
  function tile(x, y, s, letter, fill, color) {
    return `<rect x="${x}" y="${y + 1.2}" width="${s}" height="${s}" rx="${s * 0.22}" fill="rgba(0,0,0,.14)"/>` +
      `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.22}" fill="${fill || '#f7ecd2'}"/>` +
      `<text x="${x + s / 2}" y="${y + s * 0.69}" text-anchor="middle" font-size="${s * 0.52}" font-weight="700" fill="${color || '#3b3018'}" font-family="${FONT}">${letter}</text>`;
  }
  // A flat chess pawn, drawn so it looks the same everywhere. (cx, y) is
  // the middle and top of its 18-unit square.
  function pawn(cx, y, white) {
    const base = y + 15.5;
    return `<g fill="${white ? '#ffffff' : '#1d1d20'}" stroke="#1d1d20" stroke-width="1.1" stroke-linejoin="round">` +
      `<circle cx="${cx}" cy="${base - 10.6}" r="2.9"/>` +
      `<path d="M${cx - 2.6} ${base - 7.4}h5.2l1.9 5.2h-9z"/>` +
      `<rect x="${cx - 5.4}" y="${base - 2.4}" width="10.8" height="2.6" rx="1"/></g>`;
  }
  function crown(cx, cy, color) {
    return `<path d="M${cx - 4.5} ${cy + 2.5}l-1-6 3.2 2.6 2.3-3.6 2.3 3.6 3.2-2.6-1 6z" fill="${color}"/>`;
  }

  const ART = {
    connect4() {
      let s = '<rect x="38" y="14" width="84" height="72" rx="12" fill="#2563eb"/>';
      const grid = ['......', '...y..', '..ry..', '.rryy.', 'yrrry.'];
      grid.forEach((row, r) => row.split('').forEach((ch, c) => {
        const fill = ch === 'r' ? '#ef4444' : ch === 'y' ? '#fbbf24' : '#1b45b4';
        s += `<circle cx="${51.5 + c * 11.4}" cy="${26 + r * 12}" r="4.4" fill="${fill}"/>`;
      }));
      return s;
    },
    othello() {
      let s = '<rect x="44" y="14" width="72" height="72" rx="10" fill="#1e8c4e"/>';
      for (let k = 1; k < 4; k++) s += `<path d="M${44 + k * 18} 14v72M44 ${14 + k * 18}h72" stroke="#12693a" stroke-width="1.2"/>`;
      const d = ['....', '.wb.', '.bw.', '..b.'];
      d.forEach((row, r) => row.split('').forEach((ch, c) => {
        if (ch === '.') return;
        s += `<circle cx="${53 + c * 18}" cy="${23 + r * 18}" r="6.4" fill="${ch === 'b' ? '#18181b' : '#f5f5f4'}"/>`;
      }));
      return s;
    },
    gomoku() {
      let s = '<rect x="44" y="14" width="72" height="72" rx="10" fill="#e9c48c"/>';
      for (let k = 0; k < 6; k++) s += `<path d="M${54 + k * 10.4} 24v52M54 ${24 + k * 10.4}h52" stroke="#a77c43" stroke-width=".9"/>`;
      const at = (i) => 54 + i * 10.4;
      [[1, 1], [2, 2], [3, 3], [4, 4]].forEach(([r, c]) => { s += `<circle cx="${at(c)}" cy="${at(r) - 30}" r="4.3" fill="#18181b"/>`; });
      [[1, 3], [2, 4], [3, 1], [4, 2]].forEach(([r, c]) => { s += `<circle cx="${at(c)}" cy="${at(r) - 30}" r="4.3" fill="#fafaf9"/>`; });
      return s;
    },
    tictactoe() {
      let s = '<path d="M70 22v56M90 22v56M52 40h56M52 60h56" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".18"/>';
      const X = (x, y) => `<path d="M${x - 6} ${y - 6}l12 12M${x + 6} ${y - 6}l-12 12" stroke="#f43f7a" stroke-width="4" stroke-linecap="round"/>`;
      const O = (x, y) => `<circle cx="${x}" cy="${y}" r="6.5" fill="none" stroke="#2563eb" stroke-width="4"/>`;
      s += X(60, 31) + O(80, 31) + O(100, 31) + X(80, 50) + X(100, 69) + O(60, 69);
      return s;
    },
    mancala(board, pit) {
      let s = `<rect x="18" y="28" width="124" height="44" rx="22" fill="${board}"/>`;
      s += `<rect x="25" y="35" width="15" height="30" rx="7.5" fill="${pit}"/><rect x="120" y="35" width="15" height="30" rx="7.5" fill="${pit}"/>`;
      const hues = ['#f87171', '#60a5fa', '#4ade80', '#facc15', '#c084fc'];
      for (let k = 0; k < 6; k++) {
        for (const y of [42, 58]) {
          const x = 52 + k * 11.2;
          s += `<circle cx="${x}" cy="${y}" r="4.6" fill="${pit}"/>`;
          const n = (k + y) % 3 + 1;
          for (let p = 0; p < n; p++) s += `<circle cx="${x - 1.6 + p * 1.6}" cy="${y - 0.8 + (p % 2) * 1.6}" r="1.5" fill="${hues[(k + p + y) % 5]}"/>`;
        }
      }
      for (let p = 0; p < 5; p++) s += `<circle cx="${126 + (p % 2) * 3}" cy="${42 + p * 4}" r="1.3" fill="${hues[p % 5]}"/>`;
      return s;
    },
    'mancala-capture'() { return ART.mancala('#b5773f', '#8e5728'); },
    'mancala-avalanche'() {
      return ART.mancala('#7c4fa8', '#5d3684') +
        '<path d="M53 50c8-9 22-9 30 0s22 9 30 0" stroke="#fff" stroke-width="1.6" fill="none" stroke-dasharray="2.5 2.5" stroke-linecap="round" opacity=".85"/>';
    },
    seabattle() {
      let s = '<rect x="44" y="14" width="72" height="72" rx="10" fill="#143b61"/>';
      const n = 5, size = 11.2, gap = 2, x0 = 50, y0 = 20;
      const heat = ['01210', '13531', '25752', '13531', '01210'];
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        // Cold cells stay blue; likely cells go yellow to orange.
        const fill = ['#1b4d7e', '#24608f', '#2f72a3', '#3f86b8', '#529acb', '#66afdc', '#7ac1ec', '#8fd3ff'][+heat[r][c]];
        s += `<rect x="${x0 + c * (size + gap)}" y="${y0 + r * (size + gap)}" width="${size}" height="${size}" rx="2.4" fill="${fill}"/>`;
      }
      s += `<rect x="${x0 + 3 * (size + gap)}" y="${y0 + 3 * (size + gap)}" width="${size}" height="${size}" rx="2.4" fill="#ef4444"/>`;
      s += `<path d="M${x0 + 3 * (size + gap) + 3.5} ${y0 + 3 * (size + gap) + 3.5}l4.2 4.2m0-4.2l-4.2 4.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`;
      s += '<circle cx="80" cy="50" r="8.5" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M80 38.5v5M80 56.5v5M68.5 50h5M86.5 50h5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>';
      return s;
    },
    wordhunt() {
      const L = 'TOPSAREHINGLCDEW';
      let s = '<rect x="42" y="10" width="76" height="80" rx="12" fill="#2f7a4b"/>';
      for (let i = 0; i < 16; i++) {
        const onPath = [0, 5, 6, 11].includes(i);
        s += tile(48 + (i % 4) * 16.6, 16 + Math.floor(i / 4) * 17.4, 14.6, L[i], i === 0 ? '#d4f5e0' : onPath ? '#efe2ff' : null);
      }
      const c = (i) => [48 + (i % 4) * 16.6 + 7.3, 16 + Math.floor(i / 4) * 17.4 + 7.3];
      const path = [0, 5, 6, 11];
      for (let k = 1; k < path.length; k++) {
        const [x1, y1] = c(path[k - 1]), [x2, y2] = c(path[k]);
        const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len, t = 5.4;
        s += `<path d="M${(x1 + ux * t).toFixed(1)} ${(y1 + uy * t).toFixed(1)}L${(x2 - ux * t).toFixed(1)} ${(y2 - uy * t).toFixed(1)}" stroke="#f43f7a" stroke-width="2.2" stroke-linecap="round"/>`;
      }
      return s;
    },
    anagrams() {
      let s = '';
      'LISTEN'.split('').forEach((ch, i) => { s += tile(26 + i * 18.5, 22, 16.5, ch, '#0d9488', '#fff'); });
      'SILENT'.split('').forEach((ch, i) => { s += tile(26 + i * 18.5, 61, 16.5, ch); });
      s += '<path d="M80 44v9M76.5 49.5L80 53l3.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".35"/>';
      return s;
    },
    wordbites() {
      const piece = (x, y, letters, vert, hue) => {
        const w = vert ? 17 : 17 * letters.length + 2 * (letters.length - 1), hh = vert ? 17 * letters.length + 2 * (letters.length - 1) : 17;
        let out = `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="4.5" fill="hsl(${hue},75%,58%)"/>`;
        letters.split('').forEach((ch, k) => {
          const cx = x + 8.5 + (vert ? 0 : k * 19), cy = y + 12.2 + (vert ? k * 19 : 0);
          out += `<text x="${cx}" y="${cy}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff" font-family="${FONT}">${ch}</text>`;
        });
        return out;
      };
      return piece(30, 46, 'BI', false, 25) + piece(68, 27, 'XT', true, 210) + piece(87, 46, 'E', false, 145) + piece(106, 46, 'S', false, 330) + piece(125, 27, 'ON', true, 45);
    },
    chess() {
      let s = '<clipPath id="art-board"><rect x="44" y="14" width="72" height="72" rx="9"/></clipPath><g clip-path="url(#art-board)"><rect x="44" y="14" width="72" height="72" fill="#b48a64"/>';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) s += `<rect x="${44 + c * 18}" y="${14 + r * 18}" width="18" height="18" fill="#eedcbc"/>`;
      s += '</g>';
      s += pawn(71, 50, true) + pawn(89, 32, false) + pawn(53, 68, true) + pawn(107, 14, false);
      return s;
    },
    checkers() {
      let s = '<clipPath id="art-board2"><rect x="44" y="14" width="72" height="72" rx="9"/></clipPath><g clip-path="url(#art-board2)"><rect x="44" y="14" width="72" height="72" fill="#f1e1c8"/>';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) s += `<rect x="${44 + c * 18}" y="${14 + r * 18}" width="18" height="18" fill="#6e4f43"/>`;
      s += '</g>';
      const piece = (c, r, red, king) => {
        const cx = 53 + c * 18, cy = 23 + r * 18;
        return `<circle cx="${cx}" cy="${cy}" r="6.6" fill="${red ? '#e23d3d' : '#222226'}"/>` + (king ? crown(cx, cy, '#fcd34d') : `<circle cx="${cx}" cy="${cy}" r="3.6" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1"/>`);
      };
      return s + piece(1, 1, false, true) + piece(3, 1, false) + piece(0, 2, true) + piece(2, 2, true, true) + piece(1, 3, true) + piece(3, 3, true);
    },
    dots() {
      let s = '';
      const P = (i) => 53 + i * 18, Q = (i) => 23 + i * 18;
      s += `<rect x="${P(0) + 2}" y="${Q(0) + 2}" width="14" height="14" rx="3" fill="#2f7bff" opacity=".28"/><rect x="${P(1) + 2}" y="${Q(1) + 2}" width="14" height="14" rx="3" fill="#f43f7a" opacity=".28"/>`;
      const lines = [[0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [1, 0, 1, 1, 0], [0, 1, 1, 1, 0], [1, 1, 2, 1, 1], [1, 1, 1, 2, 1], [2, 1, 2, 2, 1], [1, 2, 2, 2, 1], [2, 0, 3, 0, 0], [3, 2, 3, 3, 1], [0, 3, 1, 3, 0]];
      lines.forEach(([a, b, c, d, p]) => { s += `<line x1="${P(a)}" y1="${Q(b)}" x2="${P(c)}" y2="${Q(d)}" stroke="${p ? '#f43f7a' : '#2f7bff'}" stroke-width="2.6" stroke-linecap="round"/>`; });
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s += `<circle cx="${P(c)}" cy="${Q(r)}" r="2.4" fill="currentColor"/>`;
      return s;
    },
    filler() {
      const cols = ['#e64553', '#8ccf4d', '#fad140', '#4aa7ea', '#6c4bb4', '#454545'];
      const grid = ['301524', '052413', '240351', '413502'];
      let s = '';
      grid.forEach((row, r) => row.split('').forEach((ch, c) => {
        let k = +ch;
        if (r >= 2 && c <= 1) k = 1; // you, bottom left
        if (r <= 1 && c >= 4) k = 0; // them, top right
        s += `<rect x="${35 + c * 15.4}" y="${19 + r * 15.4}" width="14" height="14" rx="2.6" fill="${cols[k]}"/>`;
      }));
      return s;
    },
  };

  GP.art = function (id) {
    const fn = ART[id];
    return `<svg viewBox="0 0 160 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${fn ? fn() : ''}</svg>`;
  };
})();
