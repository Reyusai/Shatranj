/* ============================================================
   CHESS ENGINE
   ------------------------------------------------------------
   A complete, rule-correct chess engine that plugs into the
   existing HTML/CSS board (ids: board, turn, resetBtn,
   themeToggle, capturedWhite, capturedBlack — unchanged).

   Everything below is split into two halves:
     1) LOGIC   — pure functions that know nothing about the DOM.
                  getValidMoves(), isCheck(), isCheckmate(),
                  movePiece() live here.
     2) UI GLUE — renders boardState to the page and wires up
                  click / drag-and-drop so a user can actually
                  play.
   ============================================================ */


/* ============================================================
   1) LOGIC
   ============================================================ */

/* ---------- Piece representation ----------
   Internally a square is either `null` (empty) or an object:
     { color: "w" | "b", type: "K"|"Q"|"R"|"B"|"N"|"P" }
   The UI only ever sees the unicode symbol, looked up here. */
const SYMBOLS = {
  w: { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙" },
  b: { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" }
};

// Movement direction sets, reused by several pieces.
const ROOK_DIRS   = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const QUEEN_DIRS  = [...ROOK_DIRS, ...BISHOP_DIRS]; // also = king's 8 directions
const KNIGHT_OFFSETS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

function inBounds(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function oppositeColor(color) {
  return color === "w" ? "b" : "w";
}

/* ---------- Board setup ----------
   Row 0 = rank 8 (black's back rank), row 7 = rank 1 (white's
   back rank) — this matches the original UI's initialBoard. */
function makeInitialBoard() {
  const backRank = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  const board = [];

  board.push(backRank.map(type => ({ color: "b", type })));                 // row 0: black pieces
  board.push(Array.from({ length: 8 }, () => ({ color: "b", type: "P" }))); // row 1: black pawns
  for (let r = 2; r <= 5; r++) board.push(Array(8).fill(null));             // rows 2-5: empty
  board.push(Array.from({ length: 8 }, () => ({ color: "w", type: "P" }))); // row 6: white pawns
  board.push(backRank.map(type => ({ color: "w", type })));                 // row 7: white pieces

  return board;
}

function cloneBoard(board) {
  return board.map(row => row.map(cell => (cell ? { ...cell } : null)));
}

/* ---------- Game state ---------- */
let boardState = makeInitialBoard();
let currentTurn = "w";        // "w" (White) or "b" (Black)
let gameOver = false;

// Whether each side can still castle to that side (set false once the
// king, or that specific rook, has moved — or the rook is captured).
let castlingRights = {
  w: { kingSide: true, queenSide: true },
  b: { kingSide: true, queenSide: true }
};

// The square a pawn can capture into via en passant right now, e.g.
// { row, col }, or null if no capture is currently available.
let enPassantTarget = null;

// Piece *types* captured so far, used to render the "Captured" panels.
let capturedWhite = []; // white pieces that have been taken
let capturedBlack = []; // black pieces that have been taken


/* ---------- Pseudo-legal move generation (per piece type) ----------
   "Pseudo-legal" = obeys that piece's movement rules, but does NOT yet
   check whether it would leave the mover's own king in check. That
   filtering happens once, centrally, in getValidMoves(). */

function pawnMoves(board, row, col, enPassantTarget) {
  const piece = board[row][col];
  const dir = piece.color === "w" ? -1 : 1;        // white moves toward row 0
  const startRow = piece.color === "w" ? 6 : 1;
  const promotionRow = piece.color === "w" ? 0 : 7;
  const moves = [];

  // One square forward.
  const r1 = row + dir;
  if (inBounds(r1, col) && !board[r1][col]) {
    moves.push({ row: r1, col, isPromotion: r1 === promotionRow });

    // Two squares forward, only from the starting rank, only if both
    // squares are empty.
    const r2 = row + 2 * dir;
    if (row === startRow && !board[r2][col]) {
      moves.push({ row: r2, col, isDoubleStep: true });
    }
  }

  // Diagonal captures (including en passant).
  for (const dc of [-1, 1]) {
    const c = col + dc;
    if (!inBounds(r1, c)) continue;

    const target = board[r1][c];
    if (target && target.color !== piece.color) {
      moves.push({ row: r1, col: c, isCapture: true, isPromotion: r1 === promotionRow });
    } else if (enPassantTarget && enPassantTarget.row === r1 && enPassantTarget.col === c) {
      moves.push({ row: r1, col: c, isCapture: true, isEnPassant: true });
    }
  }

  return moves;
}

function knightMoves(board, row, col) {
  const piece = board[row][col];
  const moves = [];

  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const r = row + dr, c = col + dc;
    if (!inBounds(r, c)) continue;
    const target = board[r][c];
    if (!target || target.color !== piece.color) {
      moves.push({ row: r, col: c, isCapture: !!target });
    }
  }
  return moves;
}

// Shared sliding logic for rook / bishop / queen: walk each direction
// until the edge of the board, a friendly piece (stop before it), or
// an enemy piece (capture it, then stop).
function slidingMoves(board, row, col, directions) {
  const piece = board[row][col];
  const moves = [];

  for (const [dr, dc] of directions) {
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const target = board[r][c];
      if (!target) {
        moves.push({ row: r, col: c });
      } else {
        if (target.color !== piece.color) moves.push({ row: r, col: c, isCapture: true });
        break; // blocked either way — friendly block or capture — stop this direction
      }
      r += dr; c += dc;
    }
  }
  return moves;
}

// King moves: one step any direction, plus castling *candidates*.
// Whether castling is actually legal (king not passing through check)
// is verified later in getValidMoves, since that needs the whole
// board's attack map, not just this piece's view.
function kingMoves(board, row, col, castlingRights) {
  const piece = board[row][col];
  const moves = [];

  for (const [dr, dc] of QUEEN_DIRS) {
    const r = row + dr, c = col + dc;
    if (!inBounds(r, c)) continue;
    const target = board[r][c];
    if (!target || target.color !== piece.color) {
      moves.push({ row: r, col: c, isCapture: !!target });
    }
  }

  const rights = castlingRights[piece.color];
  const homeRow = piece.color === "w" ? 7 : 0;

  if (row === homeRow && col === 4) {
    // King-side: squares f & g must be empty, rook must still be on h-file.
    const kingSideRook = board[homeRow][7];
    if (rights.kingSide && !board[homeRow][5] && !board[homeRow][6] &&
        kingSideRook && kingSideRook.type === "R" && kingSideRook.color === piece.color) {
      moves.push({ row: homeRow, col: 6, isCastle: "king" });
    }

    // Queen-side: squares b, c & d must be empty, rook must still be on a-file.
    const queenSideRook = board[homeRow][0];
    if (rights.queenSide && !board[homeRow][1] && !board[homeRow][2] && !board[homeRow][3] &&
        queenSideRook && queenSideRook.type === "R" && queenSideRook.color === piece.color) {
      moves.push({ row: homeRow, col: 2, isCastle: "queen" });
    }
  }

  return moves;
}

// Dispatch to the right generator for whatever piece sits on (row, col).
function pseudoMovesForPiece(board, row, col, enPassantTarget, castlingRights) {
  const piece = board[row][col];
  if (!piece) return [];

  switch (piece.type) {
    case "P": return pawnMoves(board, row, col, enPassantTarget);
    case "N": return knightMoves(board, row, col);
    case "B": return slidingMoves(board, row, col, BISHOP_DIRS);
    case "R": return slidingMoves(board, row, col, ROOK_DIRS);
    case "Q": return slidingMoves(board, row, col, QUEEN_DIRS);
    case "K": return kingMoves(board, row, col, castlingRights);
    default:  return [];
  }
}


/* ---------- Check detection ---------- */

// Is (row, col) attacked by any piece of `byColor`, on the given board?
// Used for: check detection, and verifying a king doesn't castle
// through / into an attacked square.
function isSquareAttacked(board, row, col, byColor) {
  // Pawns: a byColor pawn attacks diagonally "forward" from its own
  // perspective, so work out which rank such a pawn would sit on.
  const attackerRow = byColor === "w" ? row + 1 : row - 1;
  for (const dc of [-1, 1]) {
    const c = col + dc;
    if (inBounds(attackerRow, c)) {
      const p = board[attackerRow][c];
      if (p && p.color === byColor && p.type === "P") return true;
    }
  }

  // Knights.
  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const r = row + dr, c = col + dc;
    if (inBounds(r, c)) {
      const p = board[r][c];
      if (p && p.color === byColor && p.type === "N") return true;
    }
  }

  // King (just the 8 adjacent squares — enough for attack detection).
  for (const [dr, dc] of QUEEN_DIRS) {
    const r = row + dr, c = col + dc;
    if (inBounds(r, c)) {
      const p = board[r][c];
      if (p && p.color === byColor && p.type === "K") return true;
    }
  }

  // Sliding pieces: rook/queen on straight lines, bishop/queen on diagonals.
  for (const [dr, dc] of ROOK_DIRS) {
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const p = board[r][c];
      if (p) {
        if (p.color === byColor && (p.type === "R" || p.type === "Q")) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  for (const [dr, dc] of BISHOP_DIRS) {
    let r = row + dr, c = col + dc;
    while (inBounds(r, c)) {
      const p = board[r][c];
      if (p) {
        if (p.color === byColor && (p.type === "B" || p.type === "Q")) return true;
        break;
      }
      r += dr; c += dc;
    }
  }

  return false;
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color && p.type === "K") return { row: r, col: c };
    }
  }
  return null; // should never happen in a valid game
}

function isInCheck(board, color) {
  const kingPos = findKing(board, color);
  if (!kingPos) return false;
  return isSquareAttacked(board, kingPos.row, kingPos.col, oppositeColor(color));
}

// Public, spec-named wrapper: isCheck() — defaults to whoever's turn it is.
function isCheck(color = currentTurn) {
  return isInCheck(boardState, color);
}


/* ---------- Applying a move to a (cloned) board ----------
   Used in two places: once for real, inside movePiece(); and once per
   candidate move, inside a disposable clone, purely to test "does this
   leave my own king in check?". Keeping one function for both avoids
   the two ever drifting apart and disagreeing. */
function applyMoveToBoard(board, fromRow, fromCol, move) {
  const piece = board[fromRow][fromCol];
  board[fromRow][fromCol] = null;

  // En passant: the captured pawn is NOT on the destination square —
  // it's beside the moving pawn, on its starting rank.
  if (move.isEnPassant) {
    board[fromRow][move.col] = null;
  }

  board[move.row][move.col] = piece;

  // Castling also drags the rook to its post-castle square.
  if (move.isCastle) {
    const homeRow = fromRow;
    if (move.isCastle === "king") {
      board[homeRow][5] = board[homeRow][7];
      board[homeRow][7] = null;
    } else {
      board[homeRow][3] = board[homeRow][0];
      board[homeRow][0] = null;
    }
  }

  return board;
}


/* ---------- Legal move generation ----------
   This is the one function the UI actually calls. It takes
   pseudo-legal moves and keeps only the ones that don't leave the
   mover's own king in check (and, for castling, that satisfy the
   "king may not pass through check" rule). */
function getValidMoves(row, col) {
  if (!inBounds(row, col)) return [];
  const piece = boardState[row][col];
  if (!piece || gameOver) return [];

  const pseudo = pseudoMovesForPiece(boardState, row, col, enPassantTarget, castlingRights);
  const legal = [];

  for (const move of pseudo) {
    if (move.isCastle) {
      const opponent = oppositeColor(piece.color);
      const homeRow = row;

      // Can't castle out of check, through check, or into check.
      if (isSquareAttacked(boardState, homeRow, 4, opponent)) continue;
      const passSquares = move.isCastle === "king" ? [5, 6] : [3, 2];
      const passesThroughCheck = passSquares.some(c => isSquareAttacked(boardState, homeRow, c, opponent));
      if (passesThroughCheck) continue;

      legal.push(move);
      continue;
    }

    // For every other move: simulate it on a throwaway clone and check
    // whether the mover's own king would be in check afterwards.
    const clone = cloneBoard(boardState);
    applyMoveToBoard(clone, row, col, move);
    if (!isInCheck(clone, piece.color)) {
      legal.push(move);
    }
  }

  return legal;
}

// Does `color` have at least one legal move anywhere on the board?
function hasAnyLegalMove(color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = boardState[r][c];
      if (piece && piece.color === color && getValidMoves(r, c).length > 0) {
        return true;
      }
    }
  }
  return false;
}

// Public, spec-named wrapper: isCheckmate() — in check AND no legal moves.
function isCheckmate(color = currentTurn) {
  return isInCheck(boardState, color) && !hasAnyLegalMove(color);
}

// Not explicitly requested, but needed to tell "no moves" apart from
// "no moves because you're in check" — i.e. a draw, not a loss.
function isStalemate(color = currentTurn) {
  return !isInCheck(boardState, color) && !hasAnyLegalMove(color);
}


/* ---------- Committing a move ----------
   This is the single place that actually mutates boardState. It
   re-validates against getValidMoves itself, so it's safe to call
   directly and can never be tricked into making an illegal move. */
function movePiece(fromRow, fromCol, toRow, toCol, promotionType = "Q") {
  const piece = boardState[fromRow][fromCol];
  if (!piece || piece.color !== currentTurn || gameOver) return false;

  const move = getValidMoves(fromRow, fromCol).find(m => m.row === toRow && m.col === toCol);
  if (!move) return false; // illegal move — refused

  // --- Resolve captures (normal capture, or en passant) ---
  let capturedPiece = null;
  if (move.isEnPassant) {
    capturedPiece = boardState[fromRow][toCol];
    boardState[fromRow][toCol] = null;
  } else if (boardState[toRow][toCol]) {
    capturedPiece = boardState[toRow][toCol];
  }
  if (capturedPiece) {
    (capturedPiece.color === "w" ? capturedWhite : capturedBlack).push(capturedPiece.type);
  }

  // --- Move the piece itself ---
  boardState[fromRow][fromCol] = null;
  boardState[toRow][toCol] = piece;

  // --- Castling: bring the rook along ---
  if (move.isCastle) {
    const homeRow = fromRow;
    if (move.isCastle === "king") {
      boardState[homeRow][5] = boardState[homeRow][7];
      boardState[homeRow][7] = null;
    } else {
      boardState[homeRow][3] = boardState[homeRow][0];
      boardState[homeRow][0] = null;
    }
  }

  // --- Pawn promotion ---
  if (move.isPromotion) {
    piece.type = ["Q", "R", "B", "N"].includes(promotionType) ? promotionType : "Q";
  }

  // --- Castling rights: lost once a king moves, or a specific rook
  //     moves, or a rook is captured on its home square ---
  if (piece.type === "K") {
    castlingRights[piece.color].kingSide = false;
    castlingRights[piece.color].queenSide = false;
  }
  if (piece.type === "R") {
    const homeRow = piece.color === "w" ? 7 : 0;
    if (fromRow === homeRow && fromCol === 0) castlingRights[piece.color].queenSide = false;
    if (fromRow === homeRow && fromCol === 7) castlingRights[piece.color].kingSide = false;
  }
  if (capturedPiece && capturedPiece.type === "R") {
    const oppColor = oppositeColor(piece.color);
    const homeRow = oppColor === "w" ? 7 : 0;
    if (toRow === homeRow && toCol === 0) castlingRights[oppColor].queenSide = false;
    if (toRow === homeRow && toCol === 7) castlingRights[oppColor].kingSide = false;
  }

  // --- En passant target for the *next* move only ---
  enPassantTarget = move.isDoubleStep ? { row: (fromRow + toRow) / 2, col: fromCol } : null;

  // --- Hand the turn over ---
  currentTurn = oppositeColor(currentTurn);

  return true;
}


/* ============================================================
   2) UI GLUE
   ------------------------------------------------------------
   Everything below is presentation only — it reads boardState
   and calls the pure functions above (getValidMoves, movePiece,
   isCheck, findKing, ...) but never changes how those functions
   decide what's legal. Nothing in this section touches chess rules.

   Layout of this section:
     2.1  DOM references + UI state
     2.2  SVG piece helpers
     2.3  Rendering (board, captured panels, status)
     2.4  Movement + capture animations
     2.5  Sound engine (Web Audio)
     2.6  Modals (pawn promotion, game over)
     2.7  Move flow (tap / click / drag -> commit)
     2.8  Mobile guards, reset, toggles, init

   Game modes, AI, clocks, ratings, history and undo live in
   game.js / ai.js / timer.js. This file only calls into them through
   the small `window.Game` hooks (search for "window.Game").
   ============================================================ */


/* ============================================================
   2.1  DOM REFERENCES + UI STATE
   ============================================================ */

const appEl            = document.getElementById("app");
const boardEl          = document.getElementById("board");
const turnDisplay      = document.getElementById("turn");
const resetBtn         = document.getElementById("resetBtn");
const themeToggle      = document.getElementById("themeToggle");
const soundToggle      = document.getElementById("soundToggle");
const capturedWhiteEl  = document.getElementById("capturedWhite");
const capturedBlackEl  = document.getElementById("capturedBlack");

// Modals (markup lives in Board.html)
const promotionModal   = document.getElementById("promotionModal");
const promoOptionsEl   = document.getElementById("promoOptions");
const gameOverModal    = document.getElementById("gameOverModal");
const gameOverTitleEl  = document.getElementById("gameOverTitle");
const gameOverSubEl    = document.getElementById("gameOverSub");
const gameOverTrophyEl = gameOverModal.querySelector(".trophy");
const confettiEl       = document.getElementById("confetti");
const playAgainBtn     = document.getElementById("playAgainBtn");
const closeModalBtn    = document.getElementById("closeModalBtn");

// Currently selected square (tap/click-to-move) and its legal destinations.
let selectedSquare = null;
let legalMovesForSelected = [];

// Tracks the square a drag started from, for HTML5 drag-and-drop (desktop).
let draggedFrom = null;

// The most recently completed move, purely for the "last move" highlight.
let lastMove = null; // { from: {row,col}, to: {row,col} }

// True while the promotion picker is on screen (board input is ignored).
let promotionPending = false;

// Pending "show the game-over popup" timer, so Reset can cancel it.
let gameOverTimer = null;

// Previous captured-list lengths, so only the *newest* mini piece pops in.
let shownCaptured = { w: 0, b: 0 };

// Primary input is a finger? Then the game is tap-only: no HTML5 drag.
const isTouchPrimary = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

const prefersReducedMotion = window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;


/* ============================================================
   2.2  SVG PIECE HELPERS
   The drawings live once in Board.html (<symbol id="pc-K"> ...).
   Colours come from CSS classes (.piece-white / .piece-black).
   ============================================================ */

// Markup for one piece glyph: a real inline <svg> (no <use>/CSS-variable
// inheritance), built from the shape library in Board.html. Its colour is
// decided purely by the .piece-white / .piece-black / .pc-white / .pc-black
// class on the svg or one of its ancestors. `type` is "K"|"Q"|"R"|"B"|"N"|"P".
const _shapeCache = {};
function shapeHTML(id) {
  if (!(id in _shapeCache)) {
    const el = document.getElementById(id);
    _shapeCache[id] = el ? el.innerHTML : "";
  }
  return _shapeCache[id];
}
function pieceSVG(type, extraClass = "") {
  const body = shapeHTML(`s-${type}`);
  return `<svg class="pc-svg ${extraClass}" viewBox="6 2 88 92" aria-hidden="true" focusable="false">` +
         `<g class="o">${body}</g><g class="f">${body}</g><g class="d">${shapeHTML(`d-${type}`)}</g></svg>`;
}

// Human-readable names (used for aria-labels / screen readers).
const PIECE_NAMES = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" };


/* ============================================================
   2.3  RENDERING
   ============================================================ */

// Rebuilds the whole board from boardState. Called after every move
// and on reset — guarantees the DOM always matches boardState exactly.
function renderBoard() {
  boardEl.innerHTML = "";

  // If the side to move is in check, find their king so its square can
  // be highlighted. findKing/isCheck are read-only logic helpers from
  // Section 1 — calling them doesn't modify any rule.
  const kingInCheckPos = isCheck() ? findKing(boardState, currentTurn) : null;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = document.createElement("div");
      square.classList.add("square", (row + col) % 2 === 1 ? "dark" : "light");
      square.dataset.row = row;
      square.dataset.col = col;

      const hasPieceHere = !!boardState[row][col];
      const isSelected = selectedSquare && selectedSquare.row === row && selectedSquare.col === col;
      const isLegalTarget = legalMovesForSelected.some(m => m.row === row && m.col === col);
      const isLastFrom = lastMove && lastMove.from.row === row && lastMove.from.col === col;
      const isLastTo   = lastMove && lastMove.to.row === row && lastMove.to.col === col;
      const isCheckedKingSquare = kingInCheckPos && kingInCheckPos.row === row && kingInCheckPos.col === col;

      if (isLastFrom || isLastTo) square.classList.add("last-move");
      if (isLastTo) square.classList.add("last-to");
      if (isCheckedKingSquare) square.classList.add("in-check");
      if (isSelected) square.classList.add("selected");
      if (isLegalTarget) square.classList.add(hasPieceHere ? "legal-capture" : "legal-move");

      // Tap/click to select or move.
      square.addEventListener("click", () => onSquareClick(row, col));
      // Desktop drag-and-drop (kept alongside tap-to-move).
      square.addEventListener("dragover", e => e.preventDefault());
      square.addEventListener("drop", e => onDrop(e, row, col));

      const piece = boardState[row][col];
      if (piece) {
        const pieceEl = document.createElement("div");
        pieceEl.classList.add("piece", piece.color === "w" ? "piece-white" : "piece-black");
        pieceEl.innerHTML = pieceSVG(piece.type);
        pieceEl.setAttribute("role", "img");
        pieceEl.setAttribute("aria-label", `${piece.color === "w" ? "White" : "Black"} ${PIECE_NAMES[piece.type]}`);
        pieceEl.draggable = !isTouchPrimary && !gameOver && piece.color === currentTurn;

        pieceEl.addEventListener("dragstart", () => onDragStart(row, col));
        pieceEl.addEventListener("dragend", onDragEnd);
        pieceEl.addEventListener("animationend", () => pieceEl.classList.remove("landed"));

        square.appendChild(pieceEl);
      }

      boardEl.appendChild(square);
    }
  }
}

// Cheap re-highlight that doesn't rebuild the DOM — used while a
// selection changes but no move has happened yet, so it never
// interrupts an in-progress drag.
function highlightSquares() {
  document.querySelectorAll(".square").forEach(sq => {
    const r = Number(sq.dataset.row), c = Number(sq.dataset.col);
    const hasPieceHere = !!boardState[r][c];
    const isSelected = selectedSquare && selectedSquare.row === r && selectedSquare.col === c;
    const isLegalTarget = legalMovesForSelected.some(m => m.row === r && m.col === c);

    sq.classList.toggle("selected", isSelected);
    sq.classList.toggle("legal-move", isLegalTarget && !hasPieceHere);
    sq.classList.toggle("legal-capture", isLegalTarget && hasPieceHere);
  });
}

function squareElementAt(row, col) {
  return boardEl.querySelector(`.square[data-row="${row}"][data-col="${col}"]`);
}

// Captured panels now show small SVG pieces (same artwork as the board).
function renderCapturedPieces() {
  const fill = (el, list, colorKey, cls) => {
    const prev = shownCaptured[colorKey];
    el.innerHTML = list.map((type, i) =>
      pieceSVG(type, `mini-piece ${cls}${i >= prev ? " new" : ""}`)
    ).join("");
    shownCaptured[colorKey] = list.length;
  };
  fill(capturedWhiteEl, capturedWhite, "w", "piece-white");
  fill(capturedBlackEl, capturedBlack, "b", "piece-black");
}

// Updates the "Turn: ..." line and detects checkmate / stalemate.
// Returns a small result object so the caller can react (sound, popup)
// without re-deriving anything:
//   { over: false, check: bool }
//   { over: true,  checkmate: true,  winner: "White"|"Black" }
//   { over: true,  stalemate: true }
function updateStatus() {
  const colorName = currentTurn === "w" ? "White" : "Black";

  if (!hasAnyLegalMove(currentTurn)) {
    gameOver = true;
    if (isInCheck(boardState, currentTurn)) {
      const winner = currentTurn === "w" ? "Black" : "White";
      turnDisplay.textContent = `Checkmate! ${winner} wins.`;
      return { over: true, checkmate: true, winner };
    }
    turnDisplay.textContent = "Stalemate! It's a draw.";
    return { over: true, stalemate: true };
  }

  const check = isInCheck(boardState, currentTurn);
  turnDisplay.textContent = check
    ? `Turn: ${colorName} (Check!)`
    : `Turn: ${colorName}`;
  return { over: false, check };
}


/* ============================================================
   2.4  MOVEMENT + CAPTURE ANIMATIONS
   ============================================================ */

/* ---------- Movement animation (FLIP) ----------
   The board re-renders fully on every move (simplest way to guarantee
   it always matches boardState). To avoid pieces just "popping" into
   their new square, we grab the moved piece's on-screen position
   *before* the re-render, then offset it back there right after and
   let it transition to (0,0) — a small, self-contained "FLIP" animation
   that doesn't require changing how the board is built. */
function animateMove(toRow, toCol, startRect) {
  if (prefersReducedMotion || !startRect) return;

  const destEl = squareElementAt(toRow, toCol)?.querySelector(".piece");
  if (!destEl) return;

  const endRect = destEl.getBoundingClientRect();
  const dx = startRect.left - endRect.left;
  const dy = startRect.top - endRect.top;
  if (!dx && !dy) return;

  destEl.style.transition = "none";
  destEl.style.transform = `translate(${dx}px, ${dy}px)`;

  // Next frame: clear the offset with a transition so it slides in.
  requestAnimationFrame(() => {
    destEl.style.transition = "transform 180ms ease-out";
    destEl.style.transform = "translate(0, 0)";
  });

  // Afterwards drop the inline styles (so hover / selected CSS works
  // again) and give the piece a tiny "landing" squash.
  setTimeout(() => {
    destEl.style.transition = "";
    destEl.style.transform = "";
    destEl.classList.add("landed");
  }, 200);
}

/* ---------- Capture feedback ----------
   `victim` = { type, color } of the piece that was taken; it is shown
   as a ghost that pops + fades, with a ring/spark burst and a very
   slight board nudge. Purely decorative and self-cleaning. */
function playCaptureFx(row, col, victim) {
  const sq = squareElementAt(row, col);
  if (!sq || prefersReducedMotion) return;

  if (victim) {
    const ghost = document.createElement("div");
    ghost.className = `capture-ghost ${victim.color === "w" ? "piece-white" : "piece-black"}`;
    ghost.innerHTML = pieceSVG(victim.type);
    sq.appendChild(ghost);
    setTimeout(() => ghost.remove(), 480);
  }

  const burst = document.createElement("div");
  burst.className = "capture-burst";
  for (let i = 0; i < 8; i++) {
    const spark = document.createElement("i");
    spark.style.setProperty("--a", `${i * 45 + 22}deg`);
    burst.appendChild(spark);
  }
  sq.appendChild(burst);
  setTimeout(() => burst.remove(), 520);

  boardEl.classList.remove("shake");
  void boardEl.offsetWidth;            // restart the animation
  boardEl.classList.add("shake");
}


/* ============================================================
   2.5  SOUND ENGINE
   ------------------------------------------------------------
   All sounds are synthesised with the Web Audio API — zero audio
   files means zero loading delay and no decoding hiccups.
   Each sound is a few layered "voices" (a filtered noise click for
   the wooden snap, a pitch-dropping sine for the body, optional
   tones for pings / chords) routed through one master gain and a
   compressor, so rapid play never clips or piles up.

   Mobile browsers keep audio locked until a user gesture, so the
   context is created + resumed on the first touch/click/key.
   ============================================================ */

let soundsEnabled = true;

const Sound = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let bus = null;   // per-sound gain node: every voice of ONE sound feeds it,
                    // and the next sound fades it out => sounds never overlap

  function init() {
    if (ctx) return ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      ctx = new AudioCtx({ latencyHint: "interactive" });
    } catch (e) {
      ctx = new AudioCtx();
    }

    // master -> compressor -> speakers (prevents clipping when sounds stack)
    master = ctx.createGain();
    master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(ctx.destination);

    // One reusable burst of white noise (0.25 s) for all "click" voices.
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    return ctx;
  }

  // Must be called from inside a user gesture (iOS/Android requirement).
  function unlock() {
    const c = init();
    if (!c) return;
    if (c.state === "suspended") c.resume();
    // iOS quirk: playing a silent buffer once fully unlocks output.
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  }

  /* --- voices --- */

  // Filtered noise burst: the crisp "tick" / "crack".
  function noise(t, { freq = 1800, q = 1, gain = 0.5, dur = 0.05, type = "bandpass" } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus || master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // Oscillator with a fast attack + exponential decay; optional pitch glide.
  function tone(t, { freq = 440, freqEnd = null, type = "sine", gain = 0.3, attack = 0.003, dur = 0.12 } = {}) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(bus || master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /* --- the sound palette --- */

  const sounds = {
    // Soft click: a short, gentle wooden tick (quiet and low-pitched).
    move(t) {
      noise(t, { freq: 1700, q: 1.1, gain: 0.32, dur: 0.035 });
      tone(t, { freq: 200, freqEnd: 120, gain: 0.32, dur: 0.07 });
    },
    // Capture: noticeably stronger - hard crack, deep punch, metallic zing.
    capture(t) {
      noise(t, { freq: 1300, q: 0.7, gain: 0.95, dur: 0.1 });
      noise(t + 0.01, { freq: 5000, q: 0.8, gain: 0.3, dur: 0.05, type: "highpass" });
      tone(t, { freq: 180, freqEnd: 45, gain: 0.95, dur: 0.22 });
      tone(t, { freq: 560, freqEnd: 240, type: "square", gain: 0.05, dur: 0.07 });
    },
    // Check: clear two-tone alert (rising, bright, unmistakable).
    check(t) {
      noise(t, { freq: 1700, q: 1.1, gain: 0.3, dur: 0.035 });
      tone(t + 0.02, { freq: 740, type: "square", gain: 0.1, dur: 0.12 });
      tone(t + 0.02, { freq: 740, type: "triangle", gain: 0.28, dur: 0.12 });
      tone(t + 0.15, { freq: 1108, type: "square", gain: 0.1, dur: 0.22 });
      tone(t + 0.15, { freq: 1108, type: "triangle", gain: 0.28, dur: 0.22 });
    },
    // Checkmate: impact, then a rising victory fanfare ending on a held chord.
    checkmate(t) {
      noise(t, { freq: 1300, q: 0.7, gain: 0.8, dur: 0.1 });
      tone(t, { freq: 150, freqEnd: 40, gain: 0.8, dur: 0.25 });
      // C-E-G-C arpeggio, then the full major chord rings out.
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(t + 0.14 + i * 0.1, { freq: f, type: "triangle", gain: 0.26, dur: 0.22 }));
      [523.25, 659.25, 783.99, 1046.5].forEach(f => {
        tone(t + 0.56, { freq: f, type: "triangle", gain: 0.2, dur: 0.9 });
        tone(t + 0.56, { freq: f * 2, type: "sine", gain: 0.05, dur: 0.7 });
      });
    },
    // Quick ascending sparkle for pawn promotion.
    promote(t) {
      sounds.move(t);
      [784, 988, 1319].forEach((f, i) =>
        tone(t + 0.05 + i * 0.06, { freq: f, type: "triangle", gain: 0.2, dur: 0.18 }));
    },
    // Dry little tick used by the low-time warning.
    tick(t) {
      noise(t, { freq: 3200, q: 2, gain: 0.16, dur: 0.02 });
      tone(t, { freq: 1500, type: "square", gain: 0.04, dur: 0.03 });
    },
    // Soft descending pair for a draw.
    draw(t) {
      tone(t, { freq: 440, type: "triangle", gain: 0.25, dur: 0.3 });
      tone(t + 0.16, { freq: 330, type: "triangle", gain: 0.25, dur: 0.45 });
    }
  };

  function play(kind) {
    const c = init();
    if (!c || !sounds[kind]) return;
    if (c.state === "suspended") c.resume();
    // Silence whatever is still ringing (10 ms fade, no click), then start
    // this sound on a fresh bus.
    const now = c.currentTime;
    if (bus) {
      const old = bus;
      old.gain.cancelScheduledValues(now);
      old.gain.setValueAtTime(old.gain.value, now);
      old.gain.linearRampToValueAtTime(0, now + 0.01);
      setTimeout(() => { try { old.disconnect(); } catch (e) { /* already gone */ } }, 60);
    }
    bus = c.createGain();
    bus.connect(master);
    sounds[kind](now + 0.012);
  }

  return { unlock, play };
})();

function playSound(kind) {
  if (!soundsEnabled) return;
  Sound.play(kind);
}

// Unlock audio on the first real user gesture (needed on iOS / Android /
// Chrome autoplay policy). Listeners remove themselves after that.
["pointerdown", "touchend", "click", "keydown"].forEach(evt =>
  window.addEventListener(evt, function unlockOnce() {
    Sound.unlock();
    ["pointerdown", "touchend", "click", "keydown"].forEach(e => window.removeEventListener(e, unlockOnce, true));
  }, { capture: true, passive: true })
);

/* ============================================================
   2.6  MODALS
   ============================================================ */

let lastFocusedBeforeModal = null;

function openModal(modalEl, focusEl) {
  lastFocusedBeforeModal = document.activeElement;
  modalEl.classList.add("open");
  modalEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  appEl.inert = true;                               // keyboard/screen-reader can't reach the board behind it
  if (focusEl) focusEl.focus({ preventScroll: true });
}

function closeModal(modalEl) {
  modalEl.classList.remove("open");
  modalEl.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal-overlay.open")) {
    document.body.classList.remove("modal-open");
    appEl.inert = false;
    if (lastFocusedBeforeModal && lastFocusedBeforeModal.isConnected) {
      lastFocusedBeforeModal.focus({ preventScroll: true });
    }
  }
}

/* ---------- Pawn promotion picker ----------
   Shows 4 large piece buttons. There is deliberately NO close button,
   backdrop-click or Esc handling: the move can only finish once a
   piece has been chosen. `onChoose(type)` then completes the move. */
function openPromotionModal(color, onChoose) {
  promotionPending = true;

  // Show the pieces in the promoting side's colour.
  promoOptionsEl.classList.toggle("pc-white", color === "w");
  promoOptionsEl.classList.toggle("pc-black", color === "b");

  // Draw the four options (inline SVG, in the promoting side's colour).
  promoOptionsEl.querySelectorAll(".pc-slot").forEach(slot => {
    slot.innerHTML = pieceSVG(slot.dataset.piece);
  });

  let chosen = false;
  const buttons = [...promoOptionsEl.querySelectorAll(".promo-btn")];
  buttons.forEach(b => b.classList.remove("chosen"));

  const handlers = buttons.map(btn => {
    const handler = () => {
      if (chosen) return;                            // ignore double taps
      chosen = true;
      btn.classList.add("chosen");
      buttons.forEach((b, i) => b.removeEventListener("click", handlers[i]));
      // Brief pause so the tap visibly registers, then close + play on.
      setTimeout(() => {
        closeModal(promotionModal);
        promotionPending = false;
        onChoose(btn.dataset.piece);
      }, 180);
    };
    btn.addEventListener("click", handler);
    return handler;
  });

  // Focus the card (not a button) so touch users don't see a pre-selected
  // piece; keyboard users can still Tab straight to the options.
  openModal(promotionModal, promotionModal.querySelector(".promo-card"));
}

// Esc must NOT dismiss the promotion picker (selection is mandatory).
promotionModal.addEventListener("keydown", e => {
  if (e.key === "Escape") e.preventDefault();
});

/* ---------- Game over popup ----------
   result = { checkmate: true, winner: "White" | "Black" } or { stalemate: true } */
function showGameOver(result) {
  // A win is either a checkmate or the opponent running out of time.
  const isMate = !!(result.checkmate || result.timeout);

  gameOverTitleEl.textContent = isMate ? `${result.winner} Wins!` : "It's a Draw!";
  gameOverSubEl.textContent   = result.checkmate ? "Checkmate" : result.timeout ? "Time out" : "Stalemate";
  if (window.Game) window.Game.decorateGameOver(result);   // fills in the rating line

  // Trophy: the winner's king, or a handshake for a draw.
  gameOverTrophyEl.classList.toggle("pc-white", isMate && result.winner === "White");
  gameOverTrophyEl.classList.toggle("pc-black", isMate && result.winner === "Black");
  gameOverTrophyEl.innerHTML = isMate
    ? pieceSVG("K")
    : `<span style="font-size:42px;line-height:56px;display:block">🤝</span>`;

  // Confetti for a win (skipped for reduced motion / draws).
  confettiEl.innerHTML = "";
  if (isMate && !prefersReducedMotion) {
    const colors = ["#f5c242", "#e8624f", "#5aa9e6", "#7cc576", "#c58af0", "#ffffff"];
    for (let i = 0; i < 40; i++) {
      const piece = document.createElement("i");
      piece.style.cssText =
        `--x:${Math.random() * 100}%;--c:${colors[i % colors.length]};` +
        `--d:${1.6 + Math.random() * 1.4}s;--delay:${Math.random() * 0.5}s;` +
        `--r:${(Math.random() * 720 - 360).toFixed(0)}deg`;
      confettiEl.appendChild(piece);
    }
  }

  openModal(gameOverModal, playAgainBtn);
}

playAgainBtn.addEventListener("click", () => {
  closeModal(gameOverModal);
  resetGame();
});
closeModalBtn.addEventListener("click", () => closeModal(gameOverModal));
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && gameOverModal.classList.contains("open")) closeModal(gameOverModal);
});


/* ============================================================
   2.7  MOVE FLOW  (tap / click / drag -> commit)
   ============================================================ */

/* ---------- Hooks into game.js (modes / AI / clocks) ----------
   game.js is loaded after this file and registers itself as window.Game.
   Every call below is guarded, so this file still works on its own
   (as a plain two-player board) if game.js is not loaded. */
function inputLocked() {
  return !!(window.Game && window.Game.inputBlocked());
}

function clearSelection() {
  selectedSquare = null;
  legalMovesForSelected = [];
}

/* ---------- Move attempts (shared by tap-to-move and drag-and-drop) ----------
   Validates against the engine, then either finishes the move straight
   away or — for a promotion — asks the player to pick a piece first. */
function attemptMove(fromRow, fromCol, toRow, toCol) {
  if (promotionPending || inputLocked()) return;
  const move = getValidMoves(fromRow, fromCol).find(m => m.row === toRow && m.col === toCol);

  if (!move) {
    clearSelection();
    highlightSquares(); // just clear stale highlights, nothing else to do
    return;
  }

  if (move.isPromotion) {
    // Keep the pawn highlighted while the picker is open; finish the
    // move only after a piece has been tapped.
    const color = boardState[fromRow][fromCol].color;
    openPromotionModal(color, type => {
      clearSelection();
      commitMove(fromRow, fromCol, toRow, toCol, type);
    });
    return;
  }

  clearSelection();
  commitMove(fromRow, fromCol, toRow, toCol, "Q");
}

/* ---------- Commit a validated move + all the feedback around it ---------- */
function commitMove(fromRow, fromCol, toRow, toCol, promotionType) {
  const move = getValidMoves(fromRow, fromCol).find(m => m.row === toRow && m.col === toCol);
  if (!move) return;

  // Capture the moving piece's current on-screen position before the
  // board re-renders, so we can animate it afterwards.
  const movingPieceEl = squareElementAt(fromRow, fromCol)?.querySelector(".piece");
  const startRect = movingPieceEl ? movingPieceEl.getBoundingClientRect() : null;

  // Who (if anyone) is about to be captured? (en passant: pawn sits beside us)
  const victimSquare = move.isEnPassant ? boardState[fromRow][toCol] : boardState[toRow][toCol];
  const victim = victimSquare ? { type: victimSquare.type, color: victimSquare.color } : null;
  const wasPromotion = !!move.isPromotion;

  // Move notation ("e4", "Nf3", "exd5", "O-O") must be built BEFORE the
  // board changes. (+ / # is added by game.js once the result is known.)
  const san = window.Game ? window.Game.buildSAN(fromRow, fromCol, toRow, toCol, promotionType, move) : null;

  const moved = movePiece(fromRow, fromCol, toRow, toCol, promotionType);
  if (!moved) return;

  lastMove = { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } };

  renderBoard();
  renderCapturedPieces();
  const status = updateStatus();

  animateMove(toRow, toCol, startRect);
  if (victim) playCaptureFx(move.isEnPassant ? fromRow : toRow, toCol, victim);

  // One sound per move, most important first (no overlapping layers).
  let sound = "move";
  if (status.checkmate)  { sound = "checkmate"; }
  else if (status.stalemate) { sound = "draw"; }
  else if (status.check) { sound = "check"; }
  else if (wasPromotion) { sound = "promote"; }
  else if (victim)       { sound = "capture"; }
  playSound(sound);

  // Tell game.js a move happened: history, clocks, ratings, AI's turn ...
  if (window.Game) window.Game.onMoveCommitted({ san, status });

  // Let the final position (and the mate sound) land, then pop the result.
  if (status.over) {
    clearTimeout(gameOverTimer);
    gameOverTimer = setTimeout(() => showGameOver(status), 900);
  }
}

/* ---------- Tap / click to move ---------- */

function onSquareClick(row, col) {
  if (gameOver || promotionPending || inputLocked()) return;

  if (selectedSquare) {
    const isTarget = legalMovesForSelected.some(m => m.row === row && m.col === col);
    if (isTarget) {
      attemptMove(selectedSquare.row, selectedSquare.col, row, col);
      return;
    }
  }

  const piece = boardState[row][col];
  if (piece && piece.color === currentTurn) {
    selectedSquare = { row, col };
    legalMovesForSelected = getValidMoves(row, col);
  } else {
    clearSelection();
  }
  highlightSquares();
}

/* ---------- Drag-and-drop (desktop) ---------- */

function onDragStart(row, col) {
  if (gameOver || promotionPending || inputLocked()) return;
  const piece = boardState[row][col];
  if (!piece || piece.color !== currentTurn) return;

  draggedFrom = { row, col };
  selectedSquare = { row, col };
  legalMovesForSelected = getValidMoves(row, col);
  highlightSquares();
}

function onDrop(e, row, col) {
  e.preventDefault();
  if (!draggedFrom) return;

  attemptMove(draggedFrom.row, draggedFrom.col, row, col);
  draggedFrom = null;
}

function onDragEnd() {
  // Fires after both successful and cancelled drags; harmless to call
  // again if attemptMove() already cleared this state. (While the
  // promotion picker is open we keep the pawn highlighted.)
  draggedFrom = null;
  if (!promotionPending) {
    clearSelection();
    highlightSquares();
  }
}


/* ============================================================
   2.8  MOBILE GUARDS, RESET, TOGGLES, INIT
   ============================================================ */

/* ---------- Instant touch feedback ----------
   pointerdown fires the moment a finger lands (before click), so the
   ripple appears with zero perceived delay. */
boardEl.addEventListener("pointerdown", e => {
  const sq = e.target.closest(".square");
  if (!sq || gameOver || promotionPending || inputLocked()) return;
  sq.classList.remove("tap");
  void sq.offsetWidth;                            // restart the animation
  sq.classList.add("tap");
  setTimeout(() => sq.classList.remove("tap"), 400);
});

/* ---------- Prevent accidental zoom / scroll / menus on the board ---------- */
// (CSS `touch-action: none` does most of the work; these cover older iOS.)
boardEl.addEventListener("touchmove", e => e.preventDefault(), { passive: false });
boardEl.addEventListener("gesturestart", e => e.preventDefault());   // iOS pinch
boardEl.addEventListener("dblclick", e => e.preventDefault());       // double-tap zoom
boardEl.addEventListener("contextmenu", e => e.preventDefault());    // long-press menu

/* ---------- Reset ---------- */

function resetGame() {
  clearTimeout(gameOverTimer);
  closeModal(gameOverModal);
  closeModal(promotionModal);
  promotionPending = false;

  boardState = makeInitialBoard();
  currentTurn = "w";
  gameOver = false;
  castlingRights = {
    w: { kingSide: true, queenSide: true },
    b: { kingSide: true, queenSide: true }
  };
  enPassantTarget = null;
  capturedWhite = [];
  capturedBlack = [];
  shownCaptured = { w: 0, b: 0 };
  clearSelection();
  draggedFrom = null;
  lastMove = null;

  renderBoard();
  renderCapturedPieces();
  turnDisplay.textContent = "Turn: White";

  // game.js: restart clocks, clear history / undo stack, refresh player bars.
  if (window.Game) window.Game.onReset();
}

resetBtn.addEventListener("click", resetGame);

/* ---------- Theme toggle (now also swaps its own icon) ---------- */

themeToggle.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  themeToggle.textContent = isDark ? "☀️" : "🌙";
  themeToggle.setAttribute("aria-pressed", String(isDark));
});

/* ---------- Sound toggle ---------- */

soundToggle.addEventListener("click", () => {
  soundsEnabled = !soundsEnabled;
  soundToggle.textContent = soundsEnabled ? "🔊" : "🔇";
  soundToggle.setAttribute("aria-pressed", String(!soundsEnabled));
});

/* ---------- Init ---------- */
renderBoard();
renderCapturedPieces();
updateStatus();
