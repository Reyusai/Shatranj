/* ============================================================
   ai.js  —  COMPUTER OPPONENT
   ------------------------------------------------------------
   Three difficulty levels:

     easy    random legal move                       (+ 300-500 ms "thinking" pause)
     medium  minimax, depth 3, material only
     hard    alpha-beta pruning + move ordering +
             iterative deepening up to depth 4 +
             capture search ("quiescence") + small
             position bonuses, with a time limit

   HOW IT FITS IN
   - It does NOT have its own chess rules. It re-uses the rule helpers
     from script.js (pseudoMovesForPiece, isSquareAttacked, cloneBoard,
     oppositeColor ...), so the AI and the game can never disagree about
     what is legal. (So script.js must be loaded before this file is
     *used* — see the <script> order in Board.html.)
   - It works on its own COPY of the position and never touches the
     real boardState.
   - It is asynchronous: the search is split into small pieces with
     setTimeout so the page stays responsive ("AI Thinking..." keeps
     animating, buttons still repaint).

   PUBLIC API
     ChessAI.chooseMove(state, level)  ->  Promise<move | null>

       state = { board, turn, cr, ep }
         board : 8x8 array like boardState (row 0 = rank 8)
         turn  : "w" | "b"        side the AI plays
         cr    : castlingRights   (same shape as in script.js)
         ep    : enPassantTarget  ({row,col} or null)
       level = "easy" | "medium" | "hard"

       move  = { fromRow, fromCol, toRow, toCol, promotion: "Q" }
   ============================================================ */

const ChessAI = (() => {

  /* ---------- 1. Settings per level ---------- */

  // Piece values (pawn = 1 ... queen = 9, multiplied by 100 so we can
  // add small positional bonuses without fractions).
  const VALUE = { P: 100, N: 300, B: 300, R: 500, Q: 900, K: 0 };

  const MATE = 100000;   // score for "checkmate"; closer mates score higher

  const LEVELS = {
    easy:   { label: "Easy",   type: "random", minDelay: 300, maxDelay: 500 },
    medium: { label: "Medium", type: "search", maxDepth: 3, prune: false, quiesce: false, pst: false,
              minDelay: 400, hardLimit: 3000 },
    hard:   { label: "Hard",   type: "search", maxDepth: 4, prune: true,  quiesce: true,  pst: true,
              minDelay: 400, hardLimit: 3500 }
  };

  let lastInfo = null;   // { depth, nodes, ms } of the latest search (handy for debugging)

  const now = () => performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const yieldToUI = () => new Promise(r => setTimeout(r, 0));


  /* ---------- 2. A private, mutable copy of the position ---------- */

  function makeState(src) {
    const S = {
      board: cloneBoard(src.board),
      turn: src.turn,
      cr: { w: { ...src.cr.w }, b: { ...src.cr.b } },
      ep: src.ep ? { row: src.ep.row, col: src.ep.col } : null,
      king: { w: null, b: null }                       // cached king squares
    };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = S.board[r][c];
        if (p && p.type === "K") S.king[p.color] = [r, c];
      }
    }
    return S;
  }

  function inCheck(S, color) {
    const k = S.king[color];
    return isSquareAttacked(S.board, k[0], k[1], oppositeColor(color));
  }


  /* ---------- 3. make / unmake a move (fast, in place) ----------
     The search plays a move, looks deeper, then takes it back. Doing
     that in place (instead of cloning the board each time) is what
     makes depth 3-4 fast enough. Every change made here is exactly
     reversed in unmake(). Queen is the only promotion the AI uses. */

  function make(S, fr, fc, m) {
    const b = S.board;
    const piece = b[fr][fc];
    const color = piece.color;
    const u = {
      fr, fc, tr: m.row, tc: m.col, piece,
      type: piece.type, castle: m.isCastle || null, enPassant: !!m.isEnPassant,
      cap: null, capRow: m.row,
      ep: S.ep, turn: S.turn,
      cr: [S.cr.w.kingSide, S.cr.w.queenSide, S.cr.b.kingSide, S.cr.b.queenSide],
      king: S.king[color]
    };

    // Captured piece (en passant: the pawn sits beside us, not on the target)
    if (m.isEnPassant) { u.capRow = fr; u.cap = b[fr][m.col]; b[fr][m.col] = null; }
    else u.cap = b[m.row][m.col];

    b[fr][fc] = null;
    b[m.row][m.col] = piece;

    // Castling: bring the rook along
    if (m.isCastle === "king")  { b[fr][5] = b[fr][7]; b[fr][7] = null; }
    if (m.isCastle === "queen") { b[fr][3] = b[fr][0]; b[fr][0] = null; }

    if (m.isPromotion) piece.type = "Q";
    if (u.type === "K") S.king[color] = [m.row, m.col];

    // Castling rights (same rules as movePiece in script.js)
    if (u.type === "K") { S.cr[color].kingSide = false; S.cr[color].queenSide = false; }
    if (u.type === "R") {
      const home = color === "w" ? 7 : 0;
      if (fr === home && fc === 0) S.cr[color].queenSide = false;
      if (fr === home && fc === 7) S.cr[color].kingSide = false;
    }
    if (u.cap && u.cap.type === "R") {
      const oc = oppositeColor(color), home = oc === "w" ? 7 : 0;
      if (m.row === home && m.col === 0) S.cr[oc].queenSide = false;
      if (m.row === home && m.col === 7) S.cr[oc].kingSide = false;
    }

    S.ep = m.isDoubleStep ? { row: (fr + m.row) / 2, col: fc } : null;
    S.turn = oppositeColor(S.turn);
    return u;
  }

  function unmake(S, u) {
    const b = S.board;
    const color = u.piece.color;

    u.piece.type = u.type;
    b[u.fr][u.fc] = u.piece;
    b[u.tr][u.tc] = null;
    if (u.cap) b[u.capRow][u.tc] = u.cap;

    if (u.castle === "king")  { b[u.fr][7] = b[u.fr][5]; b[u.fr][5] = null; }
    if (u.castle === "queen") { b[u.fr][0] = b[u.fr][3]; b[u.fr][3] = null; }

    S.cr.w.kingSide = u.cr[0]; S.cr.w.queenSide = u.cr[1];
    S.cr.b.kingSide = u.cr[2]; S.cr.b.queenSide = u.cr[3];
    S.king[color] = u.king;
    S.ep = u.ep;
    S.turn = u.turn;
  }


  /* ---------- 4. Legal move generation ----------
     pseudo-legal moves come from the game's own generator; we then keep
     only those that don't leave our king in check (and apply the same
     castling restrictions as getValidMoves in script.js).
     Returned moves are sorted "best guess first" (captures of valuable
     pieces by cheap pieces first), which makes alpha-beta prune a lot more. */

  function legalMoves(S, capturesOnly = false) {
    const b = S.board, color = S.turn, opp = oppositeColor(color);
    const out = [];

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p || p.color !== color) continue;

        for (const m of pseudoMovesForPiece(b, r, c, S.ep, S.cr)) {
          const victim = m.isEnPassant ? { type: "P" } : b[m.row][m.col];
          const isCapture = !!victim;
          if (capturesOnly && !isCapture) continue;

          if (m.isCastle) {
            // not out of / through / into check
            if (isSquareAttacked(b, r, 4, opp)) continue;
            const pass = m.isCastle === "king" ? [5, 6] : [3, 2];
            if (pass.some(col => isSquareAttacked(b, r, col, opp))) continue;
          } else {
            const u = make(S, r, c, m);
            const safe = !inCheck(S, color);
            unmake(S, u);
            if (!safe) continue;
          }

          // ordering score
          let ord = 0;
          if (isCapture) ord = 1000 + 10 * VALUE[victim.type] - VALUE[p.type] / 10;
          if (m.isPromotion) ord += 800;
          out.push({ fr: r, fc: c, m, ord });
        }
      }
    }
    return out.sort((a, z) => z.ord - a.ord);
  }


  /* ---------- 5. Evaluation ----------
     Positive = good for the side to move.
     Always: material (P1 N3 B3 R5 Q9).
     Hard only: small bonuses for advanced pawns and central knights/bishops. */

  function evaluate(S, usePST) {
    let score = 0;
    const b = S.board;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = b[r][c];
        if (!p) continue;
        let v = VALUE[p.type];
        if (usePST) v += positionBonus(p, r, c);
        score += p.color === "w" ? v : -v;
      }
    }
    return S.turn === "w" ? score : -score;
  }

  function positionBonus(p, r, c) {
    const centreFile = 3.5 - Math.abs(c - 3.5);   // 0 (edge) .. 3 (centre)
    const centreRank = 3.5 - Math.abs(r - 3.5);
    switch (p.type) {
      case "P": {
        const advance = p.color === "w" ? 6 - r : r - 1;          // 0..5 squares marched
        return advance * 6 + (c === 3 || c === 4 ? advance * 2 : 0);
      }
      case "N": return (centreFile + centreRank) * 8;
      case "B": return (centreFile + centreRank) * 4;
      case "Q": return (centreFile + centreRank) * 1;
      default:  return 0;
    }
  }


  /* ---------- 6. Search ----------
     "Negamax" = minimax written so both sides use the same code:
     my score = - (opponent's best score). Alpha-beta (when ctx.prune)
     skips branches that can't change the final answer. */

  function negamax(S, depth, alpha, beta, ply, ctx) {
    if (ctx.aborted) return 0;
    if ((++ctx.nodes & 1023) === 0 && now() > ctx.deadline) { ctx.aborted = true; return 0; }

    if (depth <= 0) return ctx.quiesce ? quiesce(S, alpha, beta, ctx, 0) : evaluate(S, ctx.pst);

    const moves = legalMoves(S);
    if (moves.length === 0) return inCheck(S, S.turn) ? -MATE + ply : 0;   // mated : stalemate

    let best = -Infinity;
    for (const mv of moves) {
      const u = make(S, mv.fr, mv.fc, mv.m);
      const score = -negamax(S, depth - 1, -beta, -alpha, ply + 1, ctx);
      unmake(S, u);
      if (ctx.aborted) return 0;

      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (ctx.prune && alpha >= beta) break;          // opponent would never allow this line
    }
    return best;
  }

  // Keep looking at captures after the nominal depth ends, so we never
  // stop in the middle of an exchange ("horizon effect").
  function quiesce(S, alpha, beta, ctx, qd) {
    const stand = evaluate(S, ctx.pst);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qd >= 4) return alpha;

    for (const mv of legalMoves(S, true)) {
      const u = make(S, mv.fr, mv.fc, mv.m);
      const score = -quiesce(S, -beta, -alpha, ctx, qd + 1);
      unmake(S, u);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  // Pick the best root move. Runs depth 1, 2, 3 ... (iterative deepening)
  // and always keeps the result of the last COMPLETED depth, so a time
  // cut-off can never leave us without a move. Yields to the browser after
  // every root move so the UI stays alive.
  async function searchRoot(S, cfg) {
    const rootMoves = legalMoves(S);
    if (rootMoves.length === 0) return null;
    if (rootMoves.length === 1) return rootMoves[0];

    // Shuffle first, then order by quality: equal moves come in random order,
    // so the AI doesn't play the identical game every time.
    for (let i = rootMoves.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rootMoves[i], rootMoves[j]] = [rootMoves[j], rootMoves[i]];
    }
    rootMoves.sort((a, z) => z.ord - a.ord);

    const t0 = now();
    let chosen = rootMoves[0];
    let totalNodes = 0, reached = 0;

    for (let depth = 1; depth <= cfg.maxDepth; depth++) {
      const ctx = { nodes: 0, aborted: false, deadline: t0 + cfg.hardLimit,
                    prune: cfg.prune, quiesce: cfg.quiesce, pst: cfg.pst };
      let alpha = -Infinity;
      let best = null;
      const scored = [];

      for (const mv of rootMoves) {
        const u = make(S, mv.fr, mv.fc, mv.m);
        const score = -negamax(S, depth - 1, -Infinity, -alpha, 1, ctx);
        unmake(S, u);
        if (ctx.aborted) break;

        mv.score = score;
        scored.push(mv);
        if (!best || score > best.score) best = mv;
        if (cfg.prune && score > alpha) alpha = score;
        await yieldToUI();
      }

      totalNodes += ctx.nodes;
      if (ctx.aborted) break;                       // ran out of time: keep previous depth's answer
      reached = depth;

      // Without pruning every score is exact, so ties are real: choose randomly among them.
      if (!cfg.prune) {
        const ties = scored.filter(mv => mv.score === best.score);
        chosen = ties[Math.floor(Math.random() * ties.length)];
      } else {
        chosen = best;
      }

      rootMoves.sort((a, z) => z.score - a.score);  // best first for the next, deeper pass
      if (best.score > MATE - 100) break;           // forced mate found: no need to look deeper
      if ((now() - t0) * 5 > cfg.hardLimit) break; // next depth would take ~5x longer: stop here
    }
    lastInfo = { depth: reached, nodes: totalNodes, ms: Math.round(now() - t0) };
    return chosen;
  }


  /* ---------- 7. Public entry point ---------- */

  async function chooseMove(state, level = "medium") {
    const cfg = LEVELS[level] || LEVELS.medium;
    const started = now();
    const S = makeState(state);

    let pick;
    if (cfg.type === "random") {
      const moves = legalMoves(S);
      pick = moves.length ? moves[Math.floor(Math.random() * moves.length)] : null;
    } else {
      pick = await searchRoot(S, cfg);
    }

    // Feel natural: never answer instantly (also gives the indicator time to show).
    const wanted = cfg.type === "random"
      ? cfg.minDelay + Math.random() * (cfg.maxDelay - cfg.minDelay)
      : cfg.minDelay;
    const wait = wanted - (now() - started);
    if (wait > 0) await sleep(wait);

    if (!pick) return null;
    return { fromRow: pick.fr, fromCol: pick.fc, toRow: pick.m.row, toCol: pick.m.col, promotion: "Q" };
  }

  return {
    chooseMove,
    LEVELS,
    get lastInfo() { return lastInfo; },
    // exposed for testing only
    _internal: { makeState, legalMoves, make, unmake, evaluate }
  };
})();
