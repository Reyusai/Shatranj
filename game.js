/* ============================================================
   game.js  —  GAME FLOW (modes, AI, clocks, ratings, history, undo)
   ------------------------------------------------------------
   This is the "glue" between the three other pieces:

     script.js  the chess rules + board drawing (unchanged logic)
     timer.js   the two clocks
     ai.js      the computer opponent

   script.js calls into this file through a few hooks (window.Game.*):

     Game.inputBlocked()      "may the human touch the board right now?"
     Game.buildSAN(...)       "what is this move called?"  (e4, Nf3, O-O ...)
     Game.onMoveCommitted()   "a move was just played"
     Game.onReset()           "the board was reset"
     Game.decorateGameOver()  "fill in the rating line of the result popup"

   In return this file reads/writes script.js's globals (boardState,
   currentTurn, gameOver ...) and calls its functions (commitMove,
   renderBoard, resetGame ...). Nothing here changes a chess rule.

   Sections:
     1. State + settings
     2. Ratings (localStorage)
     3. Small UI helpers  (all DOM updates live here)
     4. Move notation (SAN)
     5. Snapshots + undo
     6. Clocks
     7. AI turns
     8. Game end
     9. Setup screen
    10. Hooks called by script.js
    11. Init
   ============================================================ */

const Game = (() => {

  /* ============================================================
     1. STATE + SETTINGS
     ============================================================ */

  const SETTINGS_KEY = "chess.settings.v1";
  const DEFAULT_SETTINGS = { mode: "pvp", level: "medium", minutes: 5 };

  // Everything the rest of the game needs to know about "how are we playing".
  const state = {
    mode: "pvp",        // "pvp" (two players, one device)  |  "ai" (you = White, AI = Black)
    level: "medium",    // "easy" | "medium" | "hard"  (only used when mode === "ai")
    minutes: 5,         // minutes per player; 0 = no timer
    aiColor: "b",       // the colour the computer plays
    started: false,     // false until "Start Game" is pressed the first time
    setupOpen: false,   // setup screen visible?
    thinking: false,    // AI is calculating a move
    finished: false     // game ended (mate / stalemate / time out)
  };

  let history = [];         // move list in notation: ["e4", "e5", "Nf3", ...]
  let snapshots = [];       // board states after every move (for undo); [0] = start position
  let aiToken = 0;          // bumped to cancel an AI move that is still being calculated
  let ratingResult = null;  // rating changes of the game that just ended
  let lastTickSecond = null;

  // Load the last used settings (mode / level / time) so players don't re-pick every time.
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved) Object.assign(state, DEFAULT_SETTINGS, pickValid(saved));
  } catch (e) { /* no storage: use defaults */ }

  function pickValid(s) {
    const out = {};
    if (["pvp", "ai"].includes(s.mode)) out.mode = s.mode;
    if (["easy", "medium", "hard"].includes(s.level)) out.level = s.level;
    if ([0, 1, 5, 10].includes(s.minutes)) out.minutes = s.minutes;
    return out;
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY,
        JSON.stringify({ mode: state.mode, level: state.level, minutes: state.minutes }));
    } catch (e) { /* ignore */ }
  }


  /* ============================================================
     2. RATINGS  (local, stored in localStorage)
     ------------------------------------------------------------
     Two local profiles: p1 = the player of the WHITE pieces
     (that is "you" against the AI), p2 = the player of the BLACK
     pieces in Player-vs-Player. The AI is not rated.
     Win +10, loss -10, draw 0. Everybody starts at 1000.
     ============================================================ */

  const Ratings = (() => {
    const KEY = "chess.ratings.v1";
    const START = 1000;
    const STEP = 10;
    let data = { p1: START, p2: START };

    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved && Number.isFinite(saved.p1) && Number.isFinite(saved.p2)) data = saved;
    } catch (e) { /* keep defaults */ }

    function save() {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
    }

    return {
      STEP,
      get: id => data[id],
      // Add `delta` (never below 0) and report what really changed.
      apply(id, delta) {
        const before = data[id];
        data[id] = Math.max(0, before + delta);
        save();
        return { before, after: data[id], delta: data[id] - before };
      },
      reset() { data = { p1: START, p2: START }; save(); }
    };
  })();


  /* ============================================================
     3. SMALL UI HELPERS  (every DOM update for this feature)
     ============================================================ */

  const $ = id => document.getElementById(id);

  const ui = {
    app:        $("app"),
    turn:       $("turn"),
    thinking:   $("aiThinking"),
    undoBtn:    $("undoBtn"),
    menuBtn:    $("menuBtn"),
    moveList:   $("moveList"),
    ratingLine: $("ratingLine"),
    bar:   { w: $("barWhite"),    b: $("barBlack") },
    name:  { w: $("nameWhite"),   b: $("nameBlack") },
    rate:  { w: $("ratingWhite"), b: $("ratingBlack") },
    clock: { w: $("clockWhite"),  b: $("clockBlack") }
  };

  // Names shown in the player bars and in the "Turn:" label.
  function barName(color) {
    if (state.mode === "ai") return color === "w" ? "You" : `AI · ${ChessAI.LEVELS[state.level].label}`;
    return color === "w" ? "Player 1" : "Player 2";
  }
  function turnName(color) {
    if (state.mode === "ai") return color === "w" ? "You (White)" : "AI (Black)";
    return color === "w" ? "Player 1 (White)" : "Player 2 (Black)";
  }

  // Player bars: name, rating, and whether clocks are visible.
  function renderBars() {
    for (const c of ["w", "b"]) ui.name[c].textContent = barName(c);
    ui.rate.w.textContent = `⭐ ${Ratings.get("p1")}`;
    ui.rate.b.textContent = state.mode === "pvp" ? `⭐ ${Ratings.get("p2")}` : "";
    ui.app.classList.toggle("no-timer", state.minutes === 0);
  }

  // "Turn: ..." pill + highlight the active player's bar.
  function labelTurn() {
    if (!gameOver) {
      ui.turn.textContent = `Turn: ${turnName(currentTurn)}` + (isCheck() ? " (Check!)" : "");
    }
    ui.turn.classList.toggle("t-white", currentTurn === "w");
    ui.turn.classList.toggle("t-black", currentTurn === "b");
    ui.bar.w.classList.toggle("active", !gameOver && currentTurn === "w");
    ui.bar.b.classList.toggle("active", !gameOver && currentTurn === "b");
  }

  // Clock text + colours (amber when low, red + pulsing when critical).
  function renderClocks(times, active) {
    for (const c of ["w", "b"]) {
      const ms = times[c];
      const el = ui.clock[c];
      el.textContent = ChessTimer.format(ms);
      el.classList.toggle("low", timer.enabled && ms > timer.criticalThreshold && ms <= timer.lowThreshold);
      el.classList.toggle("critical", timer.enabled && ms <= timer.criticalThreshold);
      el.classList.toggle("running", timer.running && active === c);
    }
  }

  function showThinking(on) {
    ui.thinking.hidden = !on;
  }

  // Scrollable move list: "1. e4 e5" per row, newest move highlighted.
  function renderHistory() {
    if (history.length === 0) {
      ui.moveList.innerHTML = '<li class="empty">No moves yet</li>';
      return;
    }
    const last = history.length - 1;
    let html = "";
    for (let i = 0; i < history.length; i += 2) {
      html += `<li><span class="mn">${i / 2 + 1}.</span>` +
              `<span class="mv${i === last ? " cur" : ""}">${history[i]}</span>` +
              `<span class="mv${i + 1 === last ? " cur" : ""}">${history[i + 1] || ""}</span></li>`;
    }
    ui.moveList.innerHTML = html;
    ui.moveList.scrollTop = ui.moveList.scrollHeight;
  }

  // Undo: only in Player-vs-Player, only while a game is running.
  function canUndo() {
    return state.mode === "pvp" && state.started && !state.finished && !gameOver &&
           !promotionPending && history.length > 0;
  }
  function updateControls() {
    ui.undoBtn.hidden = state.mode !== "pvp";
    ui.undoBtn.disabled = !canUndo();
  }


  /* ============================================================
     4. MOVE NOTATION (SAN)  e4, Nf3, exd5, Nbd7, O-O, e8=Q
     ------------------------------------------------------------
     Built from the position BEFORE the move. "+" (check) and "#"
     (checkmate) are added afterwards in onMoveCommitted().
     ============================================================ */

  const FILES = "abcdefgh";

  function buildSAN(fromRow, fromCol, toRow, toCol, promotionType, move) {
    if (move.isCastle) return move.isCastle === "king" ? "O-O" : "O-O-O";

    const piece = boardState[fromRow][fromCol];
    const isCapture = !!move.isEnPassant || !!boardState[toRow][toCol];
    const dest = FILES[toCol] + (8 - toRow);

    // Pawns: "e4", "exd5", "e8=Q"
    if (piece.type === "P") {
      let s = isCapture ? FILES[fromCol] + "x" : "";
      s += dest;
      if (move.isPromotion) s += "=" + promotionType;
      return s;
    }

    // Pieces: letter + (disambiguation if two identical pieces could go there) + x + square
    let s = piece.type;
    const rivals = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (r === fromRow && c === fromCol) continue;
        const o = boardState[r][c];
        if (o && o.type === piece.type && o.color === piece.color &&
            getValidMoves(r, c).some(m => m.row === toRow && m.col === toCol)) {
          rivals.push({ r, c });
        }
      }
    }
    if (rivals.length) {
      const sameFile = rivals.some(o => o.c === fromCol);
      const sameRank = rivals.some(o => o.r === fromRow);
      if (!sameFile)      s += FILES[fromCol];
      else if (!sameRank) s += 8 - fromRow;
      else                s += FILES[fromCol] + (8 - fromRow);
    }
    return s + (isCapture ? "x" : "") + dest;
  }


  /* ============================================================
     5. SNAPSHOTS + UNDO
     ------------------------------------------------------------
     After every move we keep a full copy of the position. Undo just
     puts the previous copy back. (Clocks are NOT given back, as in
     real chess.)
     ============================================================ */

  function takeSnapshot() {
    return {
      board: cloneBoard(boardState),
      turn: currentTurn,
      castling: JSON.parse(JSON.stringify(castlingRights)),
      ep: enPassantTarget ? { ...enPassantTarget } : null,
      capW: capturedWhite.slice(),
      capB: capturedBlack.slice(),
      last: lastMove ? { from: { ...lastMove.from }, to: { ...lastMove.to } } : null
    };
  }

  function restoreSnapshot(s) {
    boardState = cloneBoard(s.board);
    currentTurn = s.turn;
    castlingRights = JSON.parse(JSON.stringify(s.castling));
    enPassantTarget = s.ep ? { ...s.ep } : null;
    capturedWhite = s.capW.slice();
    capturedBlack = s.capB.slice();
    lastMove = s.last ? { from: { ...s.last.from }, to: { ...s.last.to } } : null;
    gameOver = false;
    clearSelection();
  }

  function undo() {
    if (!canUndo() || snapshots.length < 2) return;
    snapshots.pop();
    history.pop();
    restoreSnapshot(snapshots[snapshots.length - 1]);

    renderBoard();
    shownCaptured = { w: capturedWhite.length, b: capturedBlack.length };   // no "pop-in" for old captures
    renderCapturedPieces();
    updateStatus();
    timer.switchTo(currentTurn);          // the clock passes back to the player who must move again
    labelTurn();
    renderHistory();
    updateControls();
  }


  /* ============================================================
     6. CLOCKS
     ============================================================ */

  let timer = null;   // (assigned just below; the constructor already calls onTick once)
  timer = new ChessTimer({
    onTick(times, active) {
      if (!timer) return;
      renderClocks(times, active);

      // Low-time warning: a quiet tick every second in the last 10 s,
      // but only for a human's clock (not while the AI is "thinking").
      if (!active || !timer.running || state.finished) return;
      const humanClock = !(state.mode === "ai" && active === state.aiColor);
      const ms = times[active];
      if (humanClock && ms > 0 && ms <= timer.criticalThreshold) {
        const sec = Math.ceil(ms / 1000);
        if (sec !== lastTickSecond) { lastTickSecond = sec; playSound("tick"); }
      }
    },
    onFlag: color => endByTimeout(color)
  });

  // A player ran out of time -> the other player wins.
  function endByTimeout(color) {
    if (gameOver || state.finished) return;
    const winner = color === "w" ? "Black" : "White";

    gameOver = true;                       // blocks every further move (script.js checks this)
    clearSelection();
    closeModal(promotionModal);            // a half-finished promotion is abandoned
    promotionPending = false;
    aiToken++;                             // cancel any AI calculation
    state.thinking = false;
    showThinking(false);

    ui.turn.textContent = `Time's up! ${winner} wins.`;
    renderBoard();
    labelTurn();

    const result = { over: true, timeout: true, winner };
    finish(result);
    playSound("check");
    clearTimeout(gameOverTimer);
    gameOverTimer = setTimeout(() => showGameOver(result), 500);
  }


  /* ============================================================
     7. AI TURNS
     ============================================================ */

  // If it's the computer's turn, ask ai.js for a move and play it.
  function maybeAI() {
    if (state.mode !== "ai" || !state.started || state.setupOpen || state.finished ||
        gameOver || promotionPending || state.thinking || currentTurn !== state.aiColor) return;

    state.thinking = true;
    showThinking(true);
    const token = ++aiToken;

    // Hand the AI a COPY of the position (it never touches the real board).
    const position = {
      board: cloneBoard(boardState),
      turn: currentTurn,
      cr: JSON.parse(JSON.stringify(castlingRights)),
      ep: enPassantTarget ? { ...enPassantTarget } : null
    };

    ChessAI.chooseMove(position, state.level)
      .catch(err => { console.error("AI error, playing a fallback move:", err); return fallbackMove(); })
      .then(mv => {
        if (token !== aiToken) return;           // game was reset / ended meanwhile: ignore
        state.thinking = false;
        showThinking(false);
        if (!mv || gameOver) return;
        commitMove(mv.fromRow, mv.fromCol, mv.toRow, mv.toCol, mv.promotion || "Q");
      });
  }

  // Only used if the AI throws an unexpected error: play the first legal move.
  function fallbackMove() {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = boardState[r][c];
        if (p && p.color === currentTurn) {
          const m = getValidMoves(r, c)[0];
          if (m) return { fromRow: r, fromCol: c, toRow: m.row, toCol: m.col, promotion: "Q" };
        }
      }
    }
    return null;
  }


  /* ============================================================
     8. GAME END  (rating update; the popup itself is in script.js)
     ============================================================ */

  function finish(result) {
    if (state.finished) return;
    state.finished = true;
    timer.stop();
    aiToken++;
    state.thinking = false;
    showThinking(false);

    const winner = (result.checkmate || result.timeout) ? result.winner : null;   // null = draw
    const delta = winner === "White" ? Ratings.STEP : winner === "Black" ? -Ratings.STEP : 0;

    ratingResult = { winner, p1: Ratings.apply("p1", delta) };
    if (state.mode === "pvp") ratingResult.p2 = Ratings.apply("p2", -delta);

    renderBars();
    labelTurn();
    updateControls();
  }

  // Called by script.js's showGameOver(): write the rating text into the popup.
  function decorateGameOver() {
    if (!ratingResult) { ui.ratingLine.textContent = ""; return; }
    const fmt = r => `${r.before} → <b>${r.after}</b> (${r.delta > 0 ? "+" : r.delta < 0 ? "−" : "±"}${Math.abs(r.delta)})`;

    if (state.mode === "ai") {
      const outcome = ratingResult.winner === "White" ? "You won!" :
                      ratingResult.winner === "Black" ? "You lost" : "Draw";
      ui.ratingLine.innerHTML = `${outcome}<br>⭐ Rating ${fmt(ratingResult.p1)}`;
    } else {
      ui.ratingLine.innerHTML =
        `⭐ Player 1: ${fmt(ratingResult.p1)}<br>⭐ Player 2: ${fmt(ratingResult.p2)}`;
    }
  }


  /* ============================================================
     9. SETUP SCREEN  (mode + difficulty + time)
     ============================================================ */

  const setupModal = $("setupModal");
  const setupCard  = setupModal.querySelector(".setup-card");
  const startBtn   = $("startBtn");
  const backBtn    = $("setupBackBtn");
  const choice     = { mode: "pvp", level: "medium", minutes: 5 };   // what's highlighted right now

  function syncSetupUI() {
    setupModal.querySelectorAll(".opt-group").forEach(group => {
      const key = group.dataset.group === "time" ? "minutes" : group.dataset.group;
      group.querySelectorAll(".seg-btn").forEach(btn => {
        btn.setAttribute("aria-checked", String(btn.dataset.value === String(choice[key])));
      });
    });
    $("levelGroup").hidden = choice.mode !== "ai";           // difficulty only matters vs AI
    $("setupRatings").textContent = choice.mode === "ai"
      ? `⭐ Your rating: ${Ratings.get("p1")}`
      : `⭐ Player 1: ${Ratings.get("p1")}   ·   Player 2: ${Ratings.get("p2")}`;
    backBtn.hidden = !state.started;                         // nothing to go back to on first launch
  }

  function openSetup() {
    Object.assign(choice, { mode: state.mode, level: state.level, minutes: state.minutes });
    syncSetupUI();

    if (state.started) {                 // pause everything while the menu is open
      timer.pause();
      aiToken++;
      state.thinking = false;
      showThinking(false);
    }
    state.setupOpen = true;
    openModal(setupModal, setupCard);
  }

  function startGame() {
    Object.assign(state, choice);        // store the chosen mode / level / time in the game state
    saveSettings();
    state.started = true;
    state.setupOpen = false;
    closeModal(setupModal);
    resetGame();                         // script.js: fresh board -> calls Game.onReset() below
  }

  function backToGame() {
    state.setupOpen = false;
    closeModal(setupModal);
    if (!state.finished) timer.resume();
    maybeAI();
  }

  setupModal.addEventListener("click", e => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    const group = btn.closest(".opt-group").dataset.group;
    choice[group === "time" ? "minutes" : group] = group === "time" ? Number(btn.dataset.value) : btn.dataset.value;
    syncSetupUI();
  });
  startBtn.addEventListener("click", startGame);
  backBtn.addEventListener("click", backToGame);
  $("resetRatingsBtn").addEventListener("click", () => {
    if (window.confirm("Reset both ratings back to 1000?")) {
      Ratings.reset();
      syncSetupUI();
      renderBars();
    }
  });
  ui.menuBtn.addEventListener("click", openSetup);
  ui.undoBtn.addEventListener("click", undo);


  /* ============================================================
     10. HOOKS CALLED BY script.js
     ============================================================ */

  // May the human use the board right now?
  function inputBlocked() {
    return !state.started || state.setupOpen || state.finished || state.thinking ||
           (state.mode === "ai" && currentTurn === state.aiColor);
  }

  // A move was just played (info.san = notation, info.status = result of updateStatus()).
  function onMoveCommitted(info) {
    const status = info.status;
    const suffix = status.checkmate ? "#" : status.check ? "+" : "";
    history.push((info.san || "?") + suffix);
    snapshots.push(takeSnapshot());
    renderHistory();

    if (status.over) {
      finish(status);                    // stops clocks, updates ratings
    } else {
      timer.switchTo(currentTurn);       // clock passes to the other player
      labelTurn();
      maybeAI();                         // computer's turn?
    }
    updateControls();
  }

  // The board was reset (New Game / Play Again / Start): start clean.
  function onReset() {
    aiToken++;                           // forget any AI move still being calculated
    state.thinking = false;
    state.finished = false;
    ratingResult = null;
    showThinking(false);

    history = [];
    snapshots = [takeSnapshot()];        // snapshot 0 = the starting position
    lastTickSecond = null;

    timer.configure(state.minutes);      // fresh clocks
    if (state.started && !state.setupOpen) timer.start("w");

    renderBars();
    renderHistory();
    labelTurn();
    updateControls();
    maybeAI();
  }


  /* ============================================================
     11. INIT  -> show the setup screen first
     ============================================================ */

  function init() {
    renderBars();
    renderHistory();
    labelTurn();
    updateControls();
    openSetup();
  }

  return {
    state, init,
    inputBlocked, buildSAN, onMoveCommitted, onReset, decorateGameOver,
    // handy for debugging / tests
    _timer: timer, _history: () => history.slice(), Ratings
  };
})();

window.Game = Game;     // script.js looks the hooks up via window.Game
Game.init();
