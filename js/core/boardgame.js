/*
 * Controller shared by every turn-based game (Connect 4, Othello, Gomoku,
 * Tic Tac Toe, Mancala, Checkers, Dots and Boxes, Filler, Chess). It owns the move history, undo/redo, the AI
 * opponent, hints, the board editor, autosave and the side panel. Each game
 * only supplies its board renderer and a few labels.
 *
 * Two ways to use it:
 *   Helper   - you are playing someone on GamePigeon. Enter your opponent's
 *              moves; the app shows (or plays, with "Bot plays my moves")
 *              the best reply and suggests their likely moves for quick entry.
 *   Practice - the computer plays the other side.
 */
(function () {
  'use strict';
  const GP = window.GP;
  const { h, button, segmented, toggle } = GP;

  class BoardGame {
    constructor(root, cfg) {
      this.root = root;
      this.cfg = cfg;
      this.engine = GP.engines[cfg.engine];
      this.token = 0;
      this.analysis = null;
      this.thinking = false;
      this.editing = false;
      this.editTool = cfg.editTools ? cfg.editTools[0].value : null;
      this.animate = null;
      this.review = null;
      this.load();
      this.build();
      this.onKey = this.onKey.bind(this);
      document.addEventListener('keydown', this.onKey);
      this.onResize = GP.debounce(() => this.renderBoard(), 150);
      window.addEventListener('resize', this.onResize);
      this.update();
    }

    /* ---------- persistence ---------- */
    defaultOptions() {
      const o = {};
      (this.cfg.options || []).forEach((opt) => (o[opt.key] = opt.default));
      return o;
    }
    load() {
      const saved = GP.store.get('game:' + this.cfg.id);
      if (saved && saved.v === 1 && saved.history && saved.history.length) {
        Object.assign(this, saved);
        this.options = Object.assign(this.defaultOptions(), saved.options);
        this.autoHint = true; // the best move always shows now
        this.idx = Math.min(this.idx, this.history.length - 1);
        // Games can convert positions saved by an older version of the app.
        if (this.cfg.migrate && this.history.some((s) => this.cfg.migrate(s) !== s)) {
          this.history = this.history.map((s) => this.cfg.migrate(s));
          this.moves = this.moves.map((m, i) => (i > 0 && m !== 'edit' ? 'edit' : m)); // old move names no longer match
          this.review = null;
        }
      } else {
        this.autoHint = true;
        this.me = 0;
        this.first = 0;
        this.mode = 'helper';
        this.autoMe = false;
        this.strength = GP.settings.strength;
        this.options = this.defaultOptions();
        this.reset(true);
      }
    }
    save() {
      GP.store.set('game:' + this.cfg.id, {
        v: 1, me: this.me, first: this.first, mode: this.mode, autoHint: this.autoHint, autoMe: this.autoMe, strength: this.strength,
        options: this.options, history: this.history, moves: this.moves, idx: this.idx, recorded: this.recorded,
        inProgress: !this.engine.result(this.state) && this.idx > 0,
        updated: Date.now(),
      });
    }
    reset(silent) {
      const s = this.engine.initial(this.initOptions(this.first));
      this.history = [s];
      this.moves = [null];
      this.idx = 0;
      this.recorded = false;
      this.editIdx = -1;
      this.review = null;
      if (!silent) {
        GP.sound.play('pop');
        this.update();
      }
    }
    initOptions(first) {
      return Object.assign({}, this.cfg.initialOptions, this.options, { first, me: this.me });
    }
    get state() { return this.history[this.idx]; }

    /* ---------- actions ---------- */
    play(move, byAI) {
      if (this.editing) return;
      const s = this.state;
      if (this.engine.result(s)) return;
      const legal = this.engine.legal(s);
      if (!legal.includes(move)) { GP.sound.play('error'); GP.buzz(30); return; }
      if (this.mode === 'ai' && s.turn !== this.me && !byAI) { GP.toast("It's the computer's turn"); return; }
      const next = this.engine.apply(s, move);
      this.history = this.history.slice(0, this.idx + 1).concat([next]);
      this.moves = this.moves.slice(0, this.idx + 1).concat([move]);
      this.idx++;
      this.recorded = this.recorded && this.idx > 0;
      this.animate = { move, from: s };
      this.review = null;
      // In bot mode, make sure the move the bot made for you gets noticed.
      if (byAI && this.mode === 'helper' && s.turn === this.me) {
        GP.toast('Bot played ' + this.cfg.moveLabel(move, s) + '. Do the same in GamePigeon.', 'good');
      }
      if (this.cfg.onPlayed) this.cfg.onPlayed(this, move, s, next);
      else GP.sound.play('place');
      GP.buzz(8);
      this.update();
    }
    undo() {
      if (this.idx === 0) return;
      let i = this.idx - 1;
      // Skip past the bot's moves, or it would just play them again.
      if (this.mode === 'ai') while (i > 0 && this.history[i].turn !== this.me) i--;
      else if (this.autoMe) while (i > 0 && this.history[i].turn === this.me && this.moves[i] !== 'edit') i--;
      this.jump(i);
    }
    redo() {
      if (this.idx < this.history.length - 1) this.jump(this.idx + 1);
    }
    jump(i) {
      GP.ai.cancel();
      this.idx = i;
      this.animate = null;
      GP.sound.play('click');
      this.update();
    }
    /* Changes a board option. newGame's Undo restores the old setting too. */
    setOption(key, value) {
      const before = Object.assign({}, this.options);
      this.options[key] = value;
      this.newGameWith(before);
    }
    /* A setting changed: start over, but let Undo restore the old setting and game. */
    newGameWith(oldOptions) {
      if (this.idx > 0 && !this.engine.result(this.state)) this.newGame('New game with the new setting', oldOptions);
      else this.reset();
    }

    /* Starts over right away; the toast's Undo brings the old game back. */
    newGame(message, oldOptions) {
      const before = { history: this.history, moves: this.moves, idx: this.idx, options: Object.assign({}, oldOptions || this.options) };
      const hadGame = this.idx > 0 && !this.engine.result(this.state);
      this.reset();
      if (hadGame) {
        GP.toast(message || 'New game', null, { label: 'Undo', onclick: () => {
          Object.assign(this, before, { review: null, recorded: false });
          this.update();
        } });
      }
    }

    /* ---------- the game loop ---------- */
    update() {
      const s = this.state;
      const res = this.engine.result(s);
      const token = ++this.token;
      this.analysis = null;
      this.thinking = false;
      if (!this.editing) this.save();
      if (res) this.finish(res);
      else if (!this.editing && !(this.review && this.review.running)) {
        if (this.botTurn()) this.think(false, token);
        else if (this.autoHint) this.analyze(false, token); // your best move, or their likely ones
      }
      this.render();
      this.animate = null;
    }

    /* True when looking at an earlier position with moves after it. */
    browsing() { return this.idx < this.history.length - 1; }

    /* Drops the moves after this position so play carries on from here. */
    playFromHere() {
      this.history = this.history.slice(0, this.idx + 1);
      this.moves = this.moves.slice(0, this.idx + 1);
      this.review = null;
      this.update();
    }

    /* True when the bot should move on its own right now. */
    botTurn() {
      const s = this.state;
      if (this.browsing()) return false; // looking back: don't overwrite the moves after this one
      if (this.mode === 'ai') return s.turn !== this.me;
      return this.autoMe && s.turn === this.me;
    }

    think(forced, token) {
      token = token || ++this.token;
      this.thinking = true;
      this.renderStatus();
      const started = Date.now();
      GP.ai.search(this.cfg.engine, this.state, this.strength).then((r) => {
        if (token !== this.token || !r) return;
        // Let the last move's animation finish (shorter when the bot is moving again, like taking a chain).
        const prev = this.idx > 0 ? this.history[this.idx - 1] : null;
        const again = prev && prev.turn === this.state.turn && this.moves[this.idx] !== 'edit';
        const wait = Math.max(0, (again ? 160 : 350) - (Date.now() - started));
        setTimeout(() => { if (token === this.token) this.play(r.move, true); }, wait);
      }, () => this.searchFailed(token));
    }

    analyze(explicit, token) {
      token = token || ++this.token;
      const s = this.state;
      this.thinking = true;
      this.renderStatus();
      GP.ai.search(this.cfg.engine, s, this.hintStrength(), 'analyze').then((r) => {
        if (token !== this.token || !r) return;
        this.thinking = false;
        this.analysis = { side: s.turn, res: r, explicit };
        if (explicit) GP.sound.play('hint');
        this.render();
      }, () => this.searchFailed(token));
    }

    /* A search errored (not just replaced by a newer one): never leave "Thinking" up. */
    searchFailed(token) {
      if (token !== this.token) return;
      this.thinking = false;
      this.render();
      GP.toast("The bot couldn't work this one out. Try Undo or Edit.", 'warn');
    }

    /*
     * How hard the best-move suggestion thinks. Against a friend it follows
     * the bot level (but never plays weak on purpose); in practice it's Normal.
     */
    hintStrength() {
      if (this.mode !== 'helper') return 'normal';
      return this.strength === 'easy' ? 'quick' : this.strength;
    }

    finish(res) {
      if (this.recorded) return;
      this.recorded = true;
      this.save();
      const iWon = res.winner === this.me, draw = res.winner == null;
      if (this.mode === 'ai') {
        const stats = GP.store.get('stats', {});
        const st = (stats[this.cfg.id] = stats[this.cfg.id] || { w: 0, l: 0, d: 0 });
        if (draw) st.d++; else if (iWon) st.w++; else st.l++;
        GP.store.set('stats', stats);
      }
      setTimeout(() => {
        if (draw) GP.sound.play('pop');
        else if (iWon) { GP.sound.play('win'); GP.confetti(); }
        else GP.sound.play('lose');
      }, 300);
    }

    onKey(e) {
      if (e.target.closest('input, textarea, select') || document.querySelector('.modal-back')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
      else if (mod) return;
      else if (e.key === 'ArrowLeft') this.undo();
      else if (e.key === 'ArrowRight') this.redo();
      else if (e.key === 'Enter' && !e.target.closest('button')) this.playSuggested(e);
      else if (e.key === 'e') this.toggleEdit();
      else if (e.key === 'Escape' && this.editing) this.toggleEdit();
      else if (this.cfg.onKey) this.cfg.onKey(this, e);
    }

    /* Enter: play the suggested move (yours), or their most likely one. */
    playSuggested(e) {
      if (this.editing || this.engine.result(this.state) || !this.analysis) return;
      const s = this.state;
      if (this.mode === 'ai' && s.turn !== this.me) return;
      const m = this.analysis.side === s.turn ? this.analysis.res.move : null;
      if (m == null) return;
      e.preventDefault();
      this.play(m);
    }

    /* ---------- editing ---------- */
    toggleEdit() {
      if (!this.cfg.edit) return;
      GP.ai.cancel();
      this.editing = !this.editing;
      if (this.editing) this.editIdx = -1;
      else this.recorded = !!this.engine.result(this.state) && this.recorded;
      GP.sound.play('click');
      this.update();
    }
    editCell(cell) {
      const next = this.cfg.edit(this.state, cell, this.editTool);
      if (!next) return;
      this.commitEdit(next);
      GP.sound.play('pop');
    }
    commitEdit(next) {
      if (this.editIdx !== this.idx) {
        this.history = this.history.slice(0, this.idx + 1).concat([next]);
        this.moves = this.moves.slice(0, this.idx + 1).concat(['edit']);
        this.idx++;
        this.editIdx = this.idx;
      } else this.history[this.idx] = next;
      this.recorded = false;
      this.save();
      this.render();
    }

    /* ---------- rendering ---------- */
    sideName(p) { return this.cfg.sides[p].name; }
    who(p) {
      if (p === this.me) return 'You';
      return this.mode === 'ai' ? 'Computer' : 'Opponent';
    }

    build() {
      const cfg = this.cfg;
      this.statusEl = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
      this.boardEl = h('div', { class: 'board-host bh-' + cfg.engine });
      this.controlsEl = h('div', { class: 'controls' });
      this.panelEl = h('aside', { class: 'panel' });
      const area = h('section', { class: 'play-area' }, this.statusEl, this.boardEl, this.controlsEl);
      this.root.appendChild(h('div', { class: 'game-layout' }, area, this.panelEl));
      this.bindSwipe(area);
    }

    render() {
      this.renderStatus();
      this.renderBoard();
      this.renderControls();
      this.renderPanel();
    }

    renderBoard() {
      const s = this.state;
      const res = this.engine.result(s);
      const hint = this.analysis && !res && !this.editing && (this.analysis.side === this.me || this.analysis.explicit)
        ? this.analysis.res : null;
      this.cfg.render(this.boardEl, {
        game: this,
        state: s,
        result: res,
        legal: res || this.editing ? [] : this.engine.legal(s),
        hint,
        editing: this.editing,
        canPlay: !res && !this.editing && !(this.mode === 'ai' && s.turn !== this.me),
        animate: this.animate,
        me: this.me,
        onMove: (m) => this.play(m),
        onEdit: (c) => this.editCell(c),
      });
    }

    renderStatus() {
      const s = this.state, res = this.engine.result(s), el = GP.clear(this.statusEl);
      let text, cls = '';
      if (this.editing) { text = 'Tap the board to change it'; cls = 'edit'; }
      else if (res) {
        if (res.winner == null) { text = "It's a tie"; cls = 'draw'; }
        else if (res.winner === this.me) { text = 'You won'; cls = 'win'; }
        else { text = (this.mode === 'ai' ? 'The computer won' : 'They won'); cls = 'lose'; }
        if (this.cfg.resultText) text += ' ' + this.cfg.resultText(res, this);
      } else if (this.thinking && this.mode === 'ai' && s.turn !== this.me) { text = 'Computer is thinking'; cls = 'thinking'; }
      else if (this.thinking && this.botTurn()) { text = 'Bot is thinking'; cls = 'thinking'; }
      else if (this.browsing() && (this.mode === 'ai' ? s.turn !== this.me : this.autoMe && s.turn === this.me)) { text = 'Earlier move'; cls = 'past'; }
      else if (s.turn === this.me) text = this.cfg.yourTurnText ? this.cfg.yourTurnText(this) : 'Your turn';
      else text = this.cfg.theirTurnText ? this.cfg.theirTurnText(this) : this.mode === 'ai' ? "Computer's turn" : 'Their turn: tap their move';
      el.className = 'status ' + cls;
      el.appendChild(this.cfg.swatch(res ? (res.winner == null ? s.turn : res.winner) : s.turn));
      el.appendChild(h('span', { class: 'status-text' }, text));
      if (cls === 'past') el.appendChild(button('Play from here', { kind: 'primary', class: 'btn-sm', onclick: () => this.playFromHere() }));
      if (cls === 'thinking') el.appendChild(h('span', { class: 'think-dots' }, h('i'), h('i'), h('i')));
      if (!res && !this.editing && this.cfg.passMove != null) {
        const legal = this.engine.legal(s);
        if (legal.length === 1 && legal[0] === this.cfg.passMove && !(this.mode === 'ai' && s.turn !== this.me)) {
          el.appendChild(button('Pass', { kind: 'primary', class: 'btn-sm', onclick: () => this.play(this.cfg.passMove) }));
        }
      }
    }

    /* The opponent's most likely moves (best first), for one-tap entry. */
    likelyMoves() {
      const a = this.analysis;
      if (!a || a.side === this.me || this.mode !== 'helper') return [];
      const sc = a.res.scores || {};
      const legal = this.engine.legal(this.state).map(String);
      // Best score first; ties keep the engine's natural order (e.g. center columns first).
      let list = Object.keys(sc).filter((m) => legal.includes(m))
        .sort((x, y) => (sc[y] - sc[x]) || (legal.indexOf(x) - legal.indexOf(y)));
      list = [String(a.res.move)].concat(list.filter((m) => m !== String(a.res.move)));
      // Restore the original move type (numbers for most games, strings for chess/checkers).
      const real = this.engine.legal(this.state);
      return list.slice(0, 3).map((m) => real.find((x) => String(x) === String(m))).filter((m) => m != null);
    }

    /* Everything the UI needs to present the current analysis, or null. */
    insight() {
      if (!this.analysis || this.engine.result(this.state)) return null;
      if (this.analysis.side !== this.me && this.mode === 'helper' && !this.analysis.explicit) return null;
      const cfg = this.cfg, r = this.analysis.res, s = this.state;
      const sc = this.analysis.side === this.me ? r.score : -r.score;
      const pct = Math.abs(sc) >= GP.DECISIVE ? (sc > 0 ? 100 : 0) : 50 + 50 * Math.tanh(sc / (cfg.evalScale || 400));
      const end = this.engine.movesToEnd && Math.abs(r.score) > GP.WIN - 1000 ? this.engine.movesToEnd(r.score) : null;
      let verdict = GP.describeScore(sc, cfg.evalUnit);
      if (end != null) verdict = (sc > 0 ? 'You win' : 'You lose') + ' in ' + GP.plural(end, 'move') + ' with best play';
      else if (Math.abs(sc) >= GP.DECISIVE) verdict = sc > 0 ? 'You are winning' : 'You are losing';
      return {
        res: r, pct, verdict,
        label: cfg.moveLabel(r.move, s),
        who: this.analysis.side === this.me ? 'you' : this.who(this.analysis.side).toLowerCase(),
        mine: this.analysis.side === this.me,
        why: cfg.explain ? cfg.explain(s, r.move, this.engine) : null,
      };
    }

    /* Compact hint bar under the board, so phones don't have to scroll to the panel. */
    renderCoach(el) {
      // Always the same fixed-height slot with at most one bar in it, so the
      // buttons and board never jump when hints or warnings come and go.
      const slot = el.appendChild(h('div', { class: 'coach-slot' }));
      const ins = this.insight();
      const s = this.state;
      if (this.editing) return;
      const res = this.engine.result(s);
      if (res) {
        // Game over: offer a review and a rematch right here.
        const rv = this.review;
        const text = rv && !rv.running ? rv.summary : rv && rv.running ? 'Reviewing ' + rv.done + ' of ' + rv.total + ' moves' : 'Game over';
        slot.appendChild(h('div', { class: 'coach done' }, GP.icon(res.winner === this.me ? 'star' : 'check'),
          h('span', { class: 'coach-text' }, h('b', null, res.winner == null ? "It's a tie" : res.winner === this.me ? 'You won' : this.who(res.winner) + ' won'),
            h('small', null, text)),
          this.history.length > 2 && !rv ? button('Review', { class: 'btn-sm', title: 'Find the mistakes in this game', onclick: () => this.runReview() }) : null,
          button('Play again', { kind: 'primary', class: 'btn-sm', onclick: () => this.newGame() })));
        return;
      }
      const likely = this.likelyMoves();
      if (likely.length && s.turn !== this.me) {
        slot.appendChild(h('div', { class: 'coach likely' }, GP.icon('bot'),
          h('span', { class: 'coach-text' }, h('b', null, 'Their move?'), h('small', null, 'Tap it on the board, or pick one')),
          h('span', { class: 'likely-moves no-swipe' }, likely.map((m, k) => button(this.cfg.moveLabel(m, s), {
            kind: k === 0 ? 'primary' : null, class: 'btn-sm', title: k === 0 ? 'Their best move' : 'Another strong move', onclick: () => this.play(m),
          })))));
        return;
      }
      if (!ins) {
        if (this.thinking && !(this.mode === 'ai' && s.turn !== this.me)) slot.appendChild(h('div', { class: 'coach thinking' }, GP.icon('bulb'), h('span', null, 'Thinking'), h('span', { class: 'think-dots' }, h('i'), h('i'), h('i'))));
        return;
      }
      const canPlay = !(this.mode === 'ai' && s.turn !== this.me);
      slot.appendChild(h('div', { class: 'coach' + (ins.pct >= 100 ? ' good' : ins.pct <= 0 ? ' bad' : '') },
        GP.icon('bulb'),
        h('span', { class: 'coach-text' }, h('b', null, (ins.mine ? 'Best move: ' : 'Their best: ') + ins.label),
          h('small', null, [ins.why, ins.verdict].filter(Boolean).join(' · '))),
        canPlay ? button('Play it', { kind: 'primary', class: 'btn-sm', onclick: () => this.play(ins.res.move) }) : null));
    }

    renderControls() {
      const el = GP.clear(this.controlsEl);
      if (this.editing) {
        const tools = segmented(this.cfg.editTools.map((t) => ({ value: t.value, label: t.label, swatch: t.swatch, cls: t.cls })), this.editTool, (v) => (this.editTool = v), 'seg-tools');
        const turn = segmented(this.cfg.sides.map((sd, i) => ({ value: i, label: sd.name + ' to move' })), this.state.turn, (v) => {
          this.commitEdit(Object.assign({}, this.state, { turn: v }));
        });
        el.append(
          h('div', { class: 'edit-bar' }, tools, turn),
          h('div', { class: 'btn-row edit-row' },
            button('Clear board', { icon: 'trash', kind: 'ghost', onclick: () => {
              const fresh = this.engine.initial(this.initOptions(this.state.turn));
              this.commitEdit(this.cfg.clearBoard ? this.cfg.clearBoard(fresh) : fresh);
            } }),
            this.cfg.extraEdit ? this.cfg.extraEdit(this) : null,
            button('Done', { icon: 'check', kind: 'primary', onclick: () => this.toggleEdit() })));
        return;
      }
      const over = !!this.engine.result(this.state);
      this.renderCoach(el);
      el.appendChild(h('div', { class: 'btn-row' },
        button('Undo', { icon: 'undo', onclick: () => this.undo(), disabled: this.idx === 0, title: 'Undo (Ctrl+Z)' }),
        button('Redo', { icon: 'redo', onclick: () => this.redo(), disabled: this.idx >= this.history.length - 1, title: 'Redo (Ctrl+Y)' }),
        this.cfg.edit ? button('Edit', { icon: 'edit', onclick: () => this.toggleEdit(), title: 'Change the board to match your game (E)' }) : null,
        button('New', { icon: 'refresh', kind: 'primary', onclick: () => this.newGame(), title: 'New game' })));
    }

    /* Redraws the side panel, keeping the cursor in a text box marked with data-fk. */
    renderPanel() {
      const a = document.activeElement;
      const fk = a && this.panelEl.contains(a) && a.dataset && a.dataset.fk;
      const sel = fk && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
      this.drawPanel();
      if (!fk) return;
      const b = this.panelEl.querySelector('[data-fk="' + fk + '"]');
      if (!b) return;
      b.focus({ preventScroll: true });
      if (sel) try { b.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text box */ }
    }

    drawPanel() {
      const el = GP.clear(this.panelEl), cfg = this.cfg;
      const sideOpts = cfg.sides.map((sd, i) => ({ value: i, label: sd.name, swatch: sd.color }));

      el.appendChild(h('div', { class: 'card' },
        h('h3', null, 'Setup'),
        h('div', { class: 'field' }, h('label', null, 'Playing against'),
          segmented([
            { value: 'helper', label: 'A friend' },
            { value: 'ai', label: 'The computer' },
          ], this.mode, (v) => { this.mode = v; this.update(); })),
        h('p', { class: 'hint-text' }, this.mode === 'helper'
          ? 'After your friend moves in GamePigeon, tap their move here. Your best move shows under the board.'
          : 'Practice against the computer. Wins and losses show on the home screen.'),
        h('div', { class: 'field' }, h('label', null, 'You are'),
          segmented(sideOpts, this.me, (v) => { this.me = v; this.recorded = true; if (this.idx === 0) this.reset(true); this.update(); })),
        cfg.fixedFirst ? null : h('div', { class: 'field' }, h('label', null, 'First move'),
          segmented(sideOpts, this.first, (v) => {
            this.first = v;
            if (this.idx === 0) this.reset(); else GP.toast('Starts with your next new game');
          })),
        this.mode === 'helper' ? toggle('Bot moves for me', this.autoMe, (v) => { this.autoMe = v; this.update(); },
          'You only tap their moves. Copy the bot\'s moves into GamePigeon.') : null,
        h('div', { class: 'field' }, h('label', null, this.mode === 'ai' ? 'Computer level' : 'Bot strength'),
          segmented(this.mode === 'ai' ? [
            { value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' }, { value: 'max', label: 'Best' },
          ] : [
            { value: 'easy', label: 'Fast' }, { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Strong' }, { value: 'max', label: 'Best' },
          ], this.strength, (v) => { this.strength = v; this.update(); })),
        this.mode === 'helper' ? h('p', { class: 'hint-text' }, 'Stronger takes a little longer to think.') : null));

      // Game options
      const opts = (cfg.options || []).filter((opt) => !opt.showIf || opt.showIf(this.options));
      if (opts.length) {
        el.appendChild(h('div', { class: 'card' }, h('h3', null, 'Board'),
          opts.map((opt) => h('div', { class: 'field' }, h('label', null, opt.label),
            opt.render ? opt.render(this, (v) => this.setOption(opt.key, v)) : segmented(opt.choices, this.options[opt.key], (v) => this.setOption(opt.key, v), opt.choices.length > 5 ? 'seg-fill' : null)))));
      }

      // Move list
      const list = h('ol', { class: 'moves' });
      const marks = (this.review && this.review.marks) || {};
      for (let i = 1; i < this.history.length; i++) {
        const prev = this.history[i - 1], m = this.moves[i];
        const label = m === 'edit' ? 'Board edited' : cfg.moveLabel(m, prev);
        const mk = marks[i];
        list.appendChild(h('li', { class: i === this.idx ? 'on' : i > this.idx ? 'future' : '', onclick: () => this.jump(i) },
          h('span', { class: 'n' }, i), m === 'edit' ? GP.icon('edit') : cfg.swatch(prev.turn), h('span', null, label),
          mk ? h('span', { class: 'mark ' + mk.kind, title: mk.title }, MARK[mk.kind]) : null,
          mk && mk.better ? h('small', { class: 'better' }, 'better: ' + mk.better) : null));
      }
      const rv = this.review;
      el.appendChild(h('div', { class: 'card' },
        h('h3', null, 'Moves',
          this.history.length > 2 ? h('button', { class: 'link', onclick: () => this.runReview(), disabled: rv && rv.running }, rv && rv.running ? 'Reviewing ' + rv.done + '/' + rv.total : 'Review game') : null,
          h('button', { class: 'link', onclick: () => this.jump(0), disabled: this.idx === 0 }, 'Start')),
        rv && !rv.running ? h('p', { class: 'review-sum' }, rv.summary) : null,
        this.history.length > 1 ? list : h('p', { class: 'hint-text' }, 'No moves yet. Tap the board to play.')));
      const on = list.querySelector('.on');
      if (on) list.scrollTop = on.offsetTop - list.clientHeight / 2;
    }

    /*
     * Looks back over the game: for every move, how much worse it was than
     * the best move available. Marks blunders (??), mistakes (?) and
     * inaccuracies (?!), and notes the better move.
     */
    async runReview() {
      GP.ai.cancel();
      this.token++;
      const cfg = this.cfg, E = this.engine, hist = this.history.slice(), moves = this.moves.slice();
      const unit = cfg.evalUnit || 100;
      const rv = (this.review = { running: true, done: 0, total: hist.length - 1, marks: {} });
      this.render();
      const best = []; // best score for the side to move at each position (their view), plus the search result
      for (let i = 0; i < hist.length; i++) {
        if (this.review !== rv) return; // a new move cancelled the review
        const res = E.result(hist[i]);
        if (res) { best[i] = { score: res.winner == null ? 0 : res.winner === hist[i].turn ? GP.WIN / 2 : -GP.WIN / 2 }; continue; }
        let r = null;
        try { r = await GP.ai.search(cfg.engine, hist[i], 'quick', 'analyze'); } catch (e) { r = null; }
        best[i] = r || { score: 0 };
        rv.done = Math.min(i + 1, rv.total);
        this.renderPanel();
        this.renderControls();
      }
      if (this.review !== rv) return;
      const count = [{ b: 0, m: 0, i: 0 }, { b: 0, m: 0, i: 0 }];
      for (let i = 1; i < hist.length; i++) {
        if (moves[i] === 'edit' || !best[i - 1].move && best[i - 1].move !== 0) continue;
        const mover = hist[i - 1].turn, bestScore = best[i - 1].score;
        const sc = best[i - 1].scores || {};
        let played = sc[moves[i]];
        if (played == null) played = hist[i].turn === mover ? best[i].score : -best[i].score;
        const loss = bestScore - played;
        let kind = null;
        if (bestScore >= GP.DECISIVE && played < GP.DECISIVE) kind = 'blunder';
        else if (bestScore > -GP.DECISIVE && played <= -GP.DECISIVE) kind = 'blunder';
        else if (Math.abs(bestScore) < GP.DECISIVE) {
          if (loss >= 3 * unit) kind = 'blunder';
          else if (loss >= 1.5 * unit) kind = 'mistake';
          else if (loss >= 0.6 * unit) kind = 'inaccuracy';
        }
        if (!kind && String(moves[i]) === String(best[i - 1].move)) kind = 'best';
        if (!kind) continue;
        const better = kind !== 'best' ? cfg.moveLabel(best[i - 1].move, hist[i - 1]) : null;
        rv.marks[i] = { kind, better, title: kind === 'best' ? 'Best move' : kind[0].toUpperCase() + kind.slice(1) + (better ? '. Better was ' + better : '') };
        if (kind !== 'best') count[mover][kind[0]]++;
      }
      const line = (p) => {
        const c = count[p], parts = [];
        if (c.b) parts.push(GP.plural(c.b, 'blunder'));
        if (c.m) parts.push(GP.plural(c.m, 'mistake'));
        if (c.i) parts.push(GP.plural(c.i, 'inaccuracy').replace('inaccuracys', 'inaccuracies'));
        return this.who(p) + ': ' + (parts.join(', ') || 'no mistakes');
      };
      rv.summary = line(this.me) + '  ·  ' + line(1 - this.me);
      rv.running = false;
      GP.sound.play('hint');
      this.update();
    }

    /* Swipe left/right on the play area to undo/redo (phones). */
    bindSwipe(el) {
      GP.onSwipe(el, () => { if (!this.editing) this.redo(); }, () => { if (!this.editing) this.undo(); });
    }

    destroy() {
      GP.ai.cancel();
      this.token++;
      document.removeEventListener('keydown', this.onKey);
      window.removeEventListener('resize', this.onResize);
    }
  }

  const MARK = { blunder: '??', mistake: '?', inaccuracy: '?!', best: '★' };

  GP.BoardGame = BoardGame;

  /* "Why" text for games where a move places a piece: winning now, or blocking a win. */
  GP.explainPlacement = function (s, m, E) {
    const r = E.result(E.apply(s, m));
    if (r && r.winner === s.turn) return 'wins right now';
    try {
      const theirs = E.result(E.apply(Object.assign({}, s, { turn: 1 - s.turn }), m));
      if (theirs && theirs.winner === 1 - s.turn) return 'blocks their win';
    } catch (e) { /* the move isn't legal for them */ }
    return null;
  };

  /* Simple circular piece swatch. */
  GP.pieceSwatch = (cls) => h('i', { class: 'piece-swatch ' + cls });
})();
