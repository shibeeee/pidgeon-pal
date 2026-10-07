/*
 * Talks to Stockfish (vendor/stockfish, GPLv3) running in its own worker,
 * using the UCI text protocol. Loaded the first time a chess game opens.
 */
(function () {
  'use strict';
  const GP = window.GP;
  const SRC = 'vendor/stockfish/stockfish-18-lite-single.js';

  // Strength presets: Stockfish's skill level (0-20) and thinking time.
  const LEVELS = {
    easy: { skill: 2, ms: 300 },
    quick: { skill: 20, ms: 300 },
    normal: { skill: 20, ms: 1000 },
    hard: { skill: 20, ms: 2500 },
    max: { skill: 20, ms: 6000 },
  };

  let worker = null, ready = null, listener = null, current = null, queue = Promise.resolve();

  function send(cmd) { worker.postMessage(cmd); }

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      try {
        worker = new Worker(SRC);
      } catch (e) {
        ready = null;
        reject(new Error('Could not start Stockfish'));
        return;
      }
      worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line === 'uciok') send('isready');
        else if (line === 'readyok' && resolve) { const r = resolve; resolve = null; r(); }
        else if (listener) listener(line);
      };
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        ready = null;
        worker = null;
        reject(new Error('Stockfish could not load. Chess hints need the page to be served over http(s).'));
      };
      send('uci');
    });
    return ready;
  }

  /* Converts a UCI score to the app's scale, from the side to move's view. */
  function toScore(kind, n) {
    if (kind === 'mate') return n > 0 ? GP.WIN - (2 * n - 1) : -(GP.WIN - 2 * -n);
    return n;
  }

  /*
   * Searches a position. Resolves {move, score, depth, scores, pv}.
   * `scores` holds the top few moves (MultiPV) when multi > 1.
   */
  function search(fen, level, multi) {
    const L = LEVELS[level] || LEVELS.normal;
    const job = queue.then(() => start()).then(() => new Promise((resolve) => {
      const lines = {};
      let depth = 0;
      current = { resolve };
      listener = (line) => {
        if (line.startsWith('info') && line.includes(' pv ')) {
          const d = +(line.match(/ depth (\d+)/) || [])[1];
          const mpv = +(line.match(/ multipv (\d+)/) || [0, 1])[1];
          const sc = line.match(/ score (cp|mate) (-?\d+)/);
          const pv = line.split(' pv ')[1].split(' ');
          if (sc && !line.includes('bound')) {
            lines[mpv] = { move: pv[0], score: toScore(sc[1], +sc[2]), pv, depth: d };
            depth = Math.max(depth, d);
          }
        } else if (line.startsWith('bestmove')) {
          const best = line.split(' ')[1];
          listener = null;
          current = null;
          const main = lines[1] || { score: 0, pv: [best] };
          const scores = {};
          Object.values(lines).forEach((x) => { scores[x.move] = x.score; });
          resolve(best && best !== '(none)' ? { move: best, score: main.score, depth, scores, pv: main.pv } : null);
        }
      };
      send('setoption name Skill Level value ' + L.skill);
      send('setoption name MultiPV value ' + (multi || 1));
      send('position fen ' + fen);
      send('go movetime ' + L.ms);
    }));
    queue = job.catch(() => {});
    return job;
  }

  function stop() {
    if (current && worker) send('stop');
  }

  GP.stockfish = { start, search, stop, LEVELS };
})();
