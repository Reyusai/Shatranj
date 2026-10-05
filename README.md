# Chess – modes, AI, clocks, ratings

## Install (30 seconds)
Put all of these files in ONE folder and open `Board.html`:

    Board.html   style.css   script.js   timer.js   ai.js   game.js

No build step, no server, no libraries.

## Who does what
| File       | Job |
|------------|-----|
| script.js  | Chess rules + drawing the board (your original, logic untouched). Calls `window.Game.*` hooks. |
| timer.js   | `ChessTimer` – two countdown clocks. Knows nothing about the page. |
| ai.js      | `ChessAI.chooseMove(position, level)` – Easy / Medium / Hard. Re-uses script.js's rule functions. |
| game.js    | Glue: setup screen, modes, ratings, move list + notation, undo, AI turns, time-outs. |
| Board.html / style.css | The new screens and styling. |

## How they connect (script.js load order matters)
    script.js  ->  timer.js  ->  ai.js  ->  game.js
game.js registers itself as `window.Game`. script.js calls it in 6 places
(search for `window.Game` in script.js):

1. `commitMove()`  – `Game.buildSAN()` before the move, `Game.onMoveCommitted()` after it
2. `resetGame()`   – `Game.onReset()`
3. `showGameOver()`– `Game.decorateGameOver()` (rating text) and "Time out" support
4. `inputLocked()` – `Game.inputBlocked()` (no moves while the AI thinks / after game end)

If you delete game.js the board still works as a plain two-player game.

## Tweaking
* Rating step (+/-10): `Ratings.STEP` in game.js
* AI strength / speed: `LEVELS` at the top of ai.js (`maxDepth`, `hardLimit` ms)
* Low-time warning colours: `lowThreshold` / `criticalThreshold` in timer.js
* Time options: the three buttons in `#setupModal` (data-value = minutes, 0 = none)
* Ratings live in localStorage under `chess.ratings.v1`; settings under `chess.settings.v1`.
