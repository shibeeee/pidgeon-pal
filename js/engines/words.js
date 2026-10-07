/*
 * Word game solvers: Anagrams, Word Hunt and Word Bites.
 * The dictionary is the public-domain ENABLE list, loaded from data/words.js.
 */
(function (root) {
  'use strict';
  const GP = (root.GP = root.GP || {});

  let LIST = null, SET = null;

  const HUNT_POINTS = { 3: 100, 4: 400, 5: 800, 6: 1400, 7: 1800, 8: 2200 };
  const ANAGRAM_POINTS = { 3: 100, 4: 400, 5: 1200, 6: 2000, 7: 3000 };

  function huntPoints(n) { return n <= 8 ? HUNT_POINTS[n] || 0 : 2200 + (n - 8) * 400; }

  function isPrefix(p) {
    let lo = 0, hi = LIST.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (LIST[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo < LIST.length && LIST[lo].startsWith(p);
  }

  const W = (GP.words = {
    huntPoints,
    anagramPoints: (n) => ANAGRAM_POINTS[n] || 0,
    ready: () => !!LIST,
    init(text) {
      if (LIST) return;
      LIST = text.split('\n');
      SET = new Set(LIST);
    },
    isWord: (w) => SET.has(w),
    isPrefix,

    /* All words that can be spelled from the given letters. */
    anagrams(letters, minLen) {
      letters = letters.toLowerCase().replace(/[^a-z]/g, '');
      minLen = minLen || 3;
      const have = new Array(26).fill(0);
      for (const ch of letters) have[ch.charCodeAt(0) - 97]++;
      const out = [];
      const need = new Array(26);
      for (const w of LIST) {
        if (w.length > letters.length || w.length < minLen) continue;
        need.fill(0);
        let ok = true;
        for (let i = 0; i < w.length; i++) {
          const k = w.charCodeAt(i) - 97;
          if (++need[k] > have[k]) { ok = false; break; }
        }
        if (ok) out.push({ word: w, score: W.anagramPoints(w.length) });
      }
      return sortWords(out);
    },

    /*
     * Word Hunt. `cells` is a flat row-major array of letters, with null for
     * holes (the Donut and Cross layouts). Tiles connect in all 8 directions.
     */
    wordHunt(cells, cols, maxLen) {
      maxLen = maxLen || 12;
      const n = cells.length, rows = n / cols;
      const adj = cells.map((_, i) => {
        const r = Math.floor(i / cols), c = i % cols, out = [];
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols && cells[rr * cols + cc]) out.push(rr * cols + cc);
        }
        return out;
      });
      const found = new Map();
      const used = new Uint8Array(n);
      const path = [];
      function dfs(i, str) {
        str += cells[i].toLowerCase();
        if (!isPrefix(str)) return;
        used[i] = 1;
        path.push(i);
        if (str.length >= 3 && SET.has(str) && !found.has(str)) found.set(str, path.slice());
        if (str.length < maxLen) for (const j of adj[i]) if (!used[j]) dfs(j, str);
        path.pop();
        used[i] = 0;
      }
      for (let i = 0; i < n; i++) if (cells[i]) dfs(i, '');
      return sortWords([...found].map(([word, p]) => ({ word, path: p, score: huntPoints(word.length) })));
    },

    /*
     * Word Bites. Pieces are single letters, horizontal pairs ("AB" reads
     * left to right) and vertical pairs ("AB" reads top to bottom).
     * A horizontal word uses singles, whole horizontal pairs, and one letter
     * of a vertical pair (the other letter sticks out above or below).
     * Vertical words work the same way with the roles swapped.
     */
    wordBites(singles, horiz, vert) {
      const MAX = { H: 8, V: 9 };
      const found = new Map();
      function run(dir) {
        const inline = dir === 'H' ? horiz : vert;
        const cross = dir === 'H' ? vert : horiz;
        const usedS = new Uint8Array(singles.length);
        const usedI = new Uint8Array(inline.length);
        const usedC = new Uint8Array(cross.length);
        const parts = [];
        function step(str) {
          if (str.length >= 3 && SET.has(str)) {
            const key = str + dir;
            if (!found.has(key)) found.set(key, { word: str, dir, parts: parts.slice(), score: huntPoints(str.length) });
          }
          if (str.length >= MAX[dir]) return;
          const tried = new Set();
          const tryAdd = (piece, add, part, mark) => {
            const next = str + add;
            const tag = part.type + piece + '|' + add;
            if (tried.has(tag) || next.length > MAX[dir] || !isPrefix(next)) return;
            tried.add(tag);
            mark(1);
            parts.push(part);
            step(next);
            parts.pop();
            mark(0);
          };
          singles.forEach((s, i) => {
            if (!usedS[i]) tryAdd(s, s, { type: 'single', letters: s }, (v) => (usedS[i] = v));
          });
          inline.forEach((s, i) => {
            if (!usedI[i]) tryAdd(s, s, { type: 'inline', letters: s }, (v) => (usedI[i] = v));
          });
          cross.forEach((s, i) => {
            if (usedC[i]) return;
            for (let k = 0; k < 2; k++) tryAdd(s, s[k], { type: 'cross', letters: s, use: k }, (v) => (usedC[i] = v));
          });
        }
        step('');
      }
      singles = singles.map((s) => s.toLowerCase());
      horiz = horiz.map((s) => s.toLowerCase());
      vert = vert.map((s) => s.toLowerCase());
      run('H');
      run('V');
      return sortWords([...found.values()]);
    },
  });

  function sortWords(arr) {
    return arr.sort((a, b) => b.word.length - a.word.length || b.score - a.score || (a.word < b.word ? -1 : 1));
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
