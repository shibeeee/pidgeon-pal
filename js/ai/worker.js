/* Runs engine searches off the main thread so the page never freezes. */
const V = self.location.search; // same build id as the page
importScripts(
  '../engines/common.js' + V,
  '../engines/c4solver.js' + V,
  '../../data/c4book.js' + V,
  '../engines/connect4.js' + V,
  '../engines/othello.js' + V,
  '../engines/gomoku.js' + V,
  '../engines/tictactoe.js' + V,
  '../engines/mancala.js' + V,
  '../engines/checkers.js' + V,
  '../engines/dots.js' + V,
  '../engines/filler.js' + V
);

self.onmessage = function (e) {
  const { id, engine, state, opts } = e.data;
  try {
    const res = self.GP.engines[engine].search(state, opts);
    self.postMessage({ id, res });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
