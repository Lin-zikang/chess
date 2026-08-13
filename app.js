'use strict';

const STORAGE = {
  double: 'lzk_chess_double_state_v1',
  levels: 'lzk_chess_levels_v1',
  activeChallenge: 'lzk_chess_active_challenge_v1',
  officialPassed: 'lzk_chess_official_passed_v1',
  games: 'lzk_chess_games_v2',
  activeDoubleGame: 'lzk_chess_active_double_game_v2',
  activeAIGame: 'lzk_chess_active_ai_game_v2',
  engineCache: 'lzk_chess_engine_cache_v2'
};

const FILES = 'abcdefgh';
const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LEVEL_MAGIC_AES = 'LZK_CHESS_LEVEL_AES';
const LEVEL_MAGIC_XOR = 'LZK_CHESS_LEVEL_XOR';
const LEVEL_PASSPHRASE = 'Lin.Zikang-2026-YE-YINFENG-OFFICIAL-LEVEL';
const SITE_CONFIG = window.CHESS_SITE_CONFIG || {};
const OFFICIAL_FOLDER = String(SITE_CONFIG.officialFolder || 'official_levels').replace(/^\/+|\/+$/g, '') || 'official_levels';
const OFFICIAL_EXTENSIONS = ['.txt'];
const DEFAULT_OFFICIAL_CREATOR = 'Ye.Yinfeng';
const PIECE_SLIDE_BASE_SQUARES_PER_SECOND = 8.6;
const PIECE_SLIDE_DISTANCE_ACCELERATION = 0.22;
const PIECE_SLIDE_DIAGONAL_ACCELERATION = 0.10;
const PIECE_SLIDE_MIN_DURATION = 110;
const PIECE_SLIDE_MAX_DURATION = 560;
const CHALLENGE_JUDGE_DELAY = 200;
const CHALLENGE_REPLY_DELAY = 300;
const AI_MIN_DELAY = 460;
const AI_MAX_DELAY = 880;
const AI_DEPTH_LEVELS = Object.freeze([11, 13, 15]);
const AI_DEFAULT_DEPTH = 13;
const AI_REVIEW_DEPTH = 15;
const CLOUD_ENGINE_TIMEOUT = 18000;
const CLOUD_ENGINE_ENDPOINT = 'https://www.stockfish.online/api/s/v2.php';
const ENGINE_CACHE_VERSION = 2;
const ENGINE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const ENGINE_CACHE_MAX_ENTRIES = 180;
const engineInflightRequests = new Map();
const engineLatestRequest = new Map();
let engineRequestSequence = 0;

const PIECE_UNICODE = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟'
};
const PIECE_NAMES = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: '' };
const PROMOTION_TYPES = ['q', 'r', 'b', 'n'];

const app = {
  view: 'home',
  play: null,
  setup: null,
  creator: null,
  challenge: null,
  selected: null,
  levels: [],
  officialIndex: null,
  officialChecked: false,
  officialStatus: 'idle',
  officialSource: '',
  officialError: '',
  busy: false,
  solutionViewer: null,
  activeChallengeKey: '',
  activeChallengeAvailable: null,
  games: [],
  ai: null,
  replay: null
};

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');
const $dynamicIsland = document.getElementById('dynamicIsland');
const $islandToggle = document.querySelector('[data-action="toggle-island"]');
const $islandViewLabel = document.getElementById('islandViewLabel');

const VIEW_LABELS = Object.freeze({
  home: '首页概览',
  double: '双人对弈',
  ai: 'AI 对弈',
  games: '棋局库',
  replay: '对局复盘',
  levels: '官方题库',
  create: '创建谜题',
  setup: '棋盘设置',
  'creator-record': '录入解法',
  challenge: '谜题挑战'
});
const VIEW_ACTIONS = Object.freeze({
  home: 'home', double: 'open-double', ai: 'open-ai', games: 'open-games',
  replay: 'open-games', levels: 'open-levels', create: 'open-create',
  setup: '', 'creator-record': 'open-create', challenge: 'open-levels'
});


function idx(row, col) { return row * 8 + col; }
function rowOf(i) { return Math.floor(i / 8); }
function colOf(i) { return i % 8; }
function inBounds(row, col) { return row >= 0 && row < 8 && col >= 0 && col < 8; }
function squareName(i) { return FILES[colOf(i)] + (8 - rowOf(i)); }
function squareToIndex(square) {
  if (!square || square === '-') return null;
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  if (file < 0 || rank < 1 || rank > 8) return null;
  return idx(8 - rank, file);
}
function opposite(color) { return color === 'w' ? 'b' : 'w'; }
function pieceKey(piece) { return piece ? piece.color + piece.type.toUpperCase() : ''; }
function cloneBoard(board) { return board.map(p => p ? { color: p.color, type: p.type } : null); }
function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay() { return AI_MIN_DELAY + Math.floor(Math.random() * (AI_MAX_DELAY - AI_MIN_DELAY + 1)); }
function officialCreatorName(value) {
  return String(value || DEFAULT_OFFICIAL_CREATOR).trim() || DEFAULT_OFFICIAL_CREATOR;
}
function creatorCopyrightText(creator, detailed = true) {
  const name = officialCreatorName(creator);
  return detailed
    ? `谜题编创者 ${name} 版权所有，未经授权不得转载、改编或商用。`
    : `谜题编创者：${name} · 版权所有`;
}
function boardContextForCurrentView() {
  if (app.view === 'creator-record') return 'creator';
  return app.view;
}
function moveAnimationParts(move) {
  const parts = [{ from: move.from, to: move.to }];
  if (move.castle === 'K') {
    const row = rowOf(move.from);
    parts.push({ from: idx(row, 7), to: idx(row, 5) });
  } else if (move.castle === 'Q') {
    const row = rowOf(move.from);
    parts.push({ from: idx(row, 0), to: idx(row, 3) });
  }
  return parts;
}
function pieceSlideDuration(fromX, fromY, toX, toY, squareWidth, squareHeight) {
  const fileDistance = Math.abs(toX - fromX) / Math.max(1, squareWidth);
  const rankDistance = Math.abs(toY - fromY) / Math.max(1, squareHeight);
  const distance = Math.hypot(fileDistance, rankDistance);
  if (!distance) return 0;

  // 每一着内部保持匀速直线运动；距离越远，巡航速度按对数平滑提高。
  // 同时按横纵位移的重合比例为斜向运动加速，补偿更长的几何路径。
  const majorAxisDistance = Math.max(fileDistance, rankDistance);
  const diagonalShare = majorAxisDistance ? Math.min(fileDistance, rankDistance) / majorAxisDistance : 0;
  const distanceBoost = 1 + PIECE_SLIDE_DISTANCE_ACCELERATION * Math.log2(Math.max(1, distance));
  const diagonalBoost = 1 + PIECE_SLIDE_DIAGONAL_ACCELERATION * diagonalShare;
  const speed = PIECE_SLIDE_BASE_SQUARES_PER_SECOND * distanceBoost * diagonalBoost;
  const naturalDuration = distance / speed * 1000;
  return Math.min(PIECE_SLIDE_MAX_DURATION, Math.max(PIECE_SLIDE_MIN_DURATION, naturalDuration));
}
function runLinearSlide(layer, fromX, fromY, toX, toY, squareWidth = layer.offsetWidth, squareHeight = layer.offsetHeight) {
  const duration = pieceSlideDuration(fromX, fromY, toX, toY, squareWidth, squareHeight);
  if (!duration) return Promise.resolve();
  const fromTransform = `translate(${fromX}px, ${fromY}px)`;
  const toTransform = `translate(${toX}px, ${toY}px)`;
  if (typeof layer.animate !== 'function') {
    layer.style.transform = toTransform;
    return sleep(duration);
  }
  const animation = layer.animate(
    [{ transform: fromTransform }, { transform: toTransform }],
    { duration, easing: 'linear', fill: 'forwards' }
  );
  return animation.finished.catch(() => {}).then(() => {
    layer.style.transform = toTransform;
    animation.cancel();
  });
}
async function beginBoardMoveSlide(move, context = boardContextForCurrentView()) {
  const board = document.querySelector(`.chessboard[data-board-context="${context}"]`);
  if (!board) return null;
  const controllers = [];
  for (const part of moveAnimationParts(move)) {
    const fromSquare = board.querySelector(`[data-square="${part.from}"]`);
    const toSquare = board.querySelector(`[data-square="${part.to}"]`);
    const sourcePiece = fromSquare?.querySelector('.piece');
    if (!fromSquare || !toSquare || !sourcePiece) continue;
    const layer = document.createElement('div');
    layer.className = 'moving-piece-layer';
    layer.style.left = `${fromSquare.offsetLeft}px`;
    layer.style.top = `${fromSquare.offsetTop}px`;
    layer.style.width = `${fromSquare.offsetWidth}px`;
    layer.style.height = `${fromSquare.offsetHeight}px`;
    layer.appendChild(sourcePiece.cloneNode(true));
    board.appendChild(layer);
    sourcePiece.style.visibility = 'hidden';
    controllers.push({
      layer,
      sourcePiece,
      dx: toSquare.offsetLeft - fromSquare.offsetLeft,
      dy: toSquare.offsetTop - fromSquare.offsetTop
    });
  }
  if (!controllers.length) return null;
  board.classList.add('is-animating');
  await Promise.all(controllers.map(item => runLinearSlide(item.layer, 0, 0, item.dx, item.dy)));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    controllers.forEach(item => {
      item.sourcePiece.style.visibility = '';
      item.layer.remove();
    });
    board.classList.remove('is-animating');
  };
  return {
    async returnToOrigin() {
      await Promise.all(controllers.map(item => runLinearSlide(item.layer, item.dx, item.dy, 0, 0)));
      cleanup();
    },
    finish: cleanup
  };
}
function updateChallengeStatus(text) {
  const status = document.querySelector('.board-wrap .status-pill');
  if (status) status.textContent = text;
}
function safeJSONParse(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }
function normalizeEngineDepth(value, fallback = AI_DEFAULT_DEPTH) {
  const numeric = Number(value);
  if (AI_DEPTH_LEVELS.includes(numeric)) return numeric;
  const base = Number.isFinite(numeric) ? numeric : fallback;
  return AI_DEPTH_LEVELS.reduce((best, candidate) => Math.abs(candidate - base) < Math.abs(best - base) ? candidate : best, AI_DEPTH_LEVELS[0]);
}
function setIslandOpen(open) {
  if (!$dynamicIsland || !$islandToggle) return;
  const next = !!open;
  $dynamicIsland.classList.toggle('is-open', next);
  $islandToggle.setAttribute('aria-expanded', String(next));
}
function updateIsland() {
  if (!$dynamicIsland) return;
  if ($islandViewLabel) $islandViewLabel.textContent = VIEW_LABELS[app.view] || 'Chess';
  const activeAction = VIEW_ACTIONS[app.view] || '';
  $dynamicIsland.querySelectorAll('.top-nav [data-action]').forEach(button => {
    if (button.dataset.action === activeAction) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}
function sanitizeFileName(name) { return String(name || 'level').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 70) || 'level'; }
function isEncryptedTxtName(name) { return /\.txt$/i.test(String(name || '')); }
function uid() { return 'lvl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); }

function parseFEN(fen) {
  const parts = String(fen || '').trim().split(/\s+/);
  if (parts.length < 4) throw new Error('FEN 不完整');
  const board = Array(64).fill(null);
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error('FEN 棋盘行数错误');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        c += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toLowerCase();
        if (!'pnbrqk'.includes(type) || c > 7) throw new Error('FEN 棋子错误');
        board[idx(r, c)] = { color, type };
        c++;
      }
    }
    if (c !== 8) throw new Error('FEN 每行格数错误');
  }
  const castling = { K: false, Q: false, k: false, q: false };
  if (parts[2] && parts[2] !== '-') {
    for (const ch of parts[2]) if (ch in castling) castling[ch] = true;
  }
  const state = {
    board,
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling,
    ep: parts[3] === '-' ? null : squareToIndex(parts[3]),
    halfmove: Number(parts[4] || 0),
    fullmove: Number(parts[5] || 1),
    history: [],
    positionCounts: {},
    initialFen: fen
  };
  state.positionCounts[positionKey(state)] = 1;
  return state;
}

function boardToFen(board) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[idx(r, c)];
      if (!p) empty++;
      else {
        if (empty) { row += empty; empty = 0; }
        const letter = p.type === 'n' ? 'n' : p.type;
        row += p.color === 'w' ? letter.toUpperCase() : letter;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

function toFEN(state) {
  const castle = ['K', 'Q', 'k', 'q'].filter(k => state.castling[k]).join('') || '-';
  const ep = state.ep == null ? '-' : squareName(state.ep);
  return `${boardToFen(state.board)} ${state.turn} ${castle} ${ep} ${state.halfmove} ${state.fullmove}`;
}

function positionKey(state) {
  const castle = ['K', 'Q', 'k', 'q'].filter(k => state.castling[k]).join('') || '-';
  const ep = state.ep == null ? '-' : squareName(state.ep);
  return `${boardToFen(state.board)} ${state.turn} ${castle} ${ep}`;
}

function createState(fen = INITIAL_FEN) {
  const state = parseFEN(fen);
  state.initialFen = fen;
  return state;
}

function packState(state) {
  return {
    fen: toFEN(state),
    initialFen: state.initialFen || toFEN(state),
    history: state.history || [],
    positionCounts: state.positionCounts || {}
  };
}

function unpackState(data = {}) {
  const initialFen = data.initialFen || data.fen || INITIAL_FEN;
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length) {
    const rebuilt = rebuildStateFromHistory(initialFen, history);
    rebuilt.initialFen = initialFen;
    return rebuilt;
  }
  const state = parseFEN(data.fen || initialFen);
  state.initialFen = initialFen;
  state.history = [];
  state.positionCounts = { [positionKey(state)]: 1 };
  return state;
}

function rebuildStateFromHistory(initialFen, history) {
  let state = createState(initialFen || INITIAL_FEN);
  for (const entry of history || []) {
    const legal = legalMoves(state);
    const move = legal.find(m => sameMove(m, entry));
    if (!move) break;
    const san = sanForMove(state, move, legal);
    state = commitMove(state, move, san);
  }
  return state;
}

function undoState(state) {
  const prevHistory = (state.history || []).slice(0, -1);
  return rebuildStateFromHistory(state.initialFen, prevHistory);
}

function lastPlayerMoveIndex(state, playerColor) {
  const history = Array.isArray(state?.history) ? state.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.color === playerColor) return i;
  }
  return -1;
}

function undoAIStateToPlayerMove(state, playerColor) {
  const playerMoveIndex = lastPlayerMoveIndex(state, playerColor);
  if (playerMoveIndex < 0) return null;
  const restored = rebuildStateFromHistory(state.initialFen, state.history.slice(0, playerMoveIndex));
  return restored.turn === playerColor ? restored : null;
}

function isSquareAttacked(board, target, byColor) {
  const tr = rowOf(target), tc = colOf(target);
  const pawnDir = byColor === 'w' ? -1 : 1;
  for (const dc of [-1, 1]) {
    const r = tr - pawnDir, c = tc - dc;
    if (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p && p.color === byColor && p.type === 'p') return true;
    }
  }
  const knightOffsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (const [dr, dc] of knightOffsets) {
    const r = tr + dr, c = tc + dc;
    if (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p && p.color === byColor && p.type === 'n') return true;
    }
  }
  const bishopDirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr, dc] of bishopDirs) {
    let r = tr + dr, c = tc + dc;
    while (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p) {
        if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  const rookDirs = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr, dc] of rookDirs) {
    let r = tr + dr, c = tc + dc;
    while (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p) {
        if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const r = tr + dr, c = tc + dc;
    if (inBounds(r, c)) {
      const p = board[idx(r, c)];
      if (p && p.color === byColor && p.type === 'k') return true;
    }
  }
  return false;
}

function kingIndex(board, color) {
  return board.findIndex(p => p && p.color === color && p.type === 'k');
}

function isInCheck(state, color) {
  const k = kingIndex(state.board, color);
  if (k < 0) return false;
  return isSquareAttacked(state.board, k, opposite(color));
}

function pushMove(moves, state, from, to, extra = {}) {
  const piece = state.board[from];
  const target = state.board[to];
  if (!piece) return;
  if (target && target.color === piece.color) return;
  moves.push({ from, to, piece: { ...piece }, capture: !!target, ...extra });
}

function generatePseudoMoves(state, from) {
  const piece = state.board[from];
  if (!piece) return [];
  const moves = [];
  const r = rowOf(from), c = colOf(from);
  const color = piece.color;
  if (piece.type === 'p') {
    const dir = color === 'w' ? -1 : 1;
    const startRow = color === 'w' ? 6 : 1;
    const promoteRow = color === 'w' ? 0 : 7;
    const oneR = r + dir;
    if (inBounds(oneR, c) && !state.board[idx(oneR, c)]) {
      const to = idx(oneR, c);
      if (oneR === promoteRow) PROMOTION_TYPES.forEach(promotion => pushMove(moves, state, from, to, { promotion }));
      else pushMove(moves, state, from, to);
      const twoR = r + dir * 2;
      if (r === startRow && inBounds(twoR, c) && !state.board[idx(twoR, c)]) {
        pushMove(moves, state, from, idx(twoR, c), { doublePawn: true });
      }
    }
    for (const dc of [-1, 1]) {
      const cr = r + dir, cc = c + dc;
      if (!inBounds(cr, cc)) continue;
      const to = idx(cr, cc);
      const target = state.board[to];
      if (target && target.color !== color) {
        if (cr === promoteRow) PROMOTION_TYPES.forEach(promotion => pushMove(moves, state, from, to, { promotion, capture: true }));
        else pushMove(moves, state, from, to, { capture: true });
      } else if (state.ep != null && state.ep === to) {
        moves.push({ from, to, piece: { ...piece }, capture: true, enPassant: true });
      }
    }
  } else if (piece.type === 'n') {
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc)) pushMove(moves, state, from, idx(nr, nc));
    }
  } else if (['b','r','q'].includes(piece.type)) {
    const dirs = [];
    if (piece.type === 'b' || piece.type === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    if (piece.type === 'r' || piece.type === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        const to = idx(nr, nc);
        const target = state.board[to];
        if (!target) pushMove(moves, state, from, to);
        else {
          if (target.color !== color) pushMove(moves, state, from, to, { capture: true });
          break;
        }
        nr += dr; nc += dc;
      }
    }
  } else if (piece.type === 'k') {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc)) pushMove(moves, state, from, idx(nr, nc));
    }
    const homeRow = color === 'w' ? 7 : 0;
    const enemy = opposite(color);
    if (r === homeRow && c === 4 && !isInCheck(state, color)) {
      const kingSide = color === 'w' ? 'K' : 'k';
      const queenSide = color === 'w' ? 'Q' : 'q';
      const rookK = state.board[idx(homeRow, 7)];
      if (state.castling[kingSide] && rookK && rookK.color === color && rookK.type === 'r' &&
          !state.board[idx(homeRow, 5)] && !state.board[idx(homeRow, 6)] &&
          !isSquareAttacked(state.board, idx(homeRow, 5), enemy) && !isSquareAttacked(state.board, idx(homeRow, 6), enemy)) {
        moves.push({ from, to: idx(homeRow, 6), piece: { ...piece }, castle: 'K' });
      }
      const rookQ = state.board[idx(homeRow, 0)];
      if (state.castling[queenSide] && rookQ && rookQ.color === color && rookQ.type === 'r' &&
          !state.board[idx(homeRow, 1)] && !state.board[idx(homeRow, 2)] && !state.board[idx(homeRow, 3)] &&
          !isSquareAttacked(state.board, idx(homeRow, 3), enemy) && !isSquareAttacked(state.board, idx(homeRow, 2), enemy)) {
        moves.push({ from, to: idx(homeRow, 2), piece: { ...piece }, castle: 'Q' });
      }
    }
  }
  return moves;
}

function applyBare(state, move) {
  const next = {
    board: cloneBoard(state.board),
    turn: opposite(state.turn),
    castling: { ...state.castling },
    ep: null,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    history: state.history ? state.history.slice() : [],
    positionCounts: { ...(state.positionCounts || {}) },
    initialFen: state.initialFen
  };
  const piece = next.board[move.from];
  const target = next.board[move.to];
  const wasCapture = !!target || move.enPassant;
  next.board[move.from] = null;

  if (move.enPassant && piece) {
    const capRow = rowOf(move.to) + (piece.color === 'w' ? 1 : -1);
    next.board[idx(capRow, colOf(move.to))] = null;
  }
  if (move.castle && piece) {
    const row = rowOf(move.from);
    if (move.castle === 'K') {
      next.board[idx(row, 5)] = next.board[idx(row, 7)];
      next.board[idx(row, 7)] = null;
    } else {
      next.board[idx(row, 3)] = next.board[idx(row, 0)];
      next.board[idx(row, 0)] = null;
    }
  }
  if (piece) {
    next.board[move.to] = { color: piece.color, type: move.promotion || piece.type };
    if (piece.type === 'p' && Math.abs(rowOf(move.from) - rowOf(move.to)) === 2) {
      next.ep = idx((rowOf(move.from) + rowOf(move.to)) / 2, colOf(move.from));
    }
    if (piece.type === 'p' || wasCapture) next.halfmove = 0;
    else next.halfmove += 1;
    if (piece.color === 'b') next.fullmove += 1;

    if (piece.type === 'k') {
      if (piece.color === 'w') { next.castling.K = false; next.castling.Q = false; }
      else { next.castling.k = false; next.castling.q = false; }
    }
    if (piece.type === 'r') {
      if (move.from === squareToIndex('h1')) next.castling.K = false;
      if (move.from === squareToIndex('a1')) next.castling.Q = false;
      if (move.from === squareToIndex('h8')) next.castling.k = false;
      if (move.from === squareToIndex('a8')) next.castling.q = false;
    }
  }
  if (target && target.type === 'r') {
    if (move.to === squareToIndex('h1')) next.castling.K = false;
    if (move.to === squareToIndex('a1')) next.castling.Q = false;
    if (move.to === squareToIndex('h8')) next.castling.k = false;
    if (move.to === squareToIndex('a8')) next.castling.q = false;
  }
  return next;
}

function legalMoves(state, onlyFrom = null) {
  const moves = [];
  const color = state.turn;
  for (let i = 0; i < 64; i++) {
    if (onlyFrom != null && i !== onlyFrom) continue;
    const p = state.board[i];
    if (!p || p.color !== color) continue;
    const pseudo = generatePseudoMoves(state, i);
    for (const move of pseudo) {
      const next = applyBare(state, move);
      if (!isInCheck(next, color)) moves.push(move);
    }
  }
  return moves;
}

function sameMove(a, b) {
  return a && b && Number(a.from) === Number(b.from) && Number(a.to) === Number(b.to) && ((a.promotion || '') === (b.promotion || ''));
}

function sanForMove(state, move, legalList = null) {
  const piece = state.board[move.from];
  if (!piece) return '';
  if (move.castle === 'K') {
    const after = applyBare(state, move);
    const status = statusAfterMove(after);
    return 'O-O' + status;
  }
  if (move.castle === 'Q') {
    const after = applyBare(state, move);
    const status = statusAfterMove(after);
    return 'O-O-O' + status;
  }
  const legal = legalList || legalMoves(state);
  const capture = !!move.capture || !!move.enPassant || !!state.board[move.to];
  let san = PIECE_NAMES[piece.type];
  if (piece.type !== 'p') {
    const others = legal.filter(m => m.from !== move.from && m.to === move.to && state.board[m.from] && state.board[m.from].type === piece.type && state.board[m.from].color === piece.color);
    if (others.length) {
      const sameFile = others.some(m => colOf(m.from) === colOf(move.from));
      const sameRank = others.some(m => rowOf(m.from) === rowOf(move.from));
      if (!sameFile) san += FILES[colOf(move.from)];
      else if (!sameRank) san += (8 - rowOf(move.from));
      else san += FILES[colOf(move.from)] + (8 - rowOf(move.from));
    }
  } else if (capture) {
    san += FILES[colOf(move.from)];
  }
  if (capture) san += 'x';
  san += squareName(move.to);
  if (move.promotion) san += '=' + PIECE_NAMES[move.promotion];
  const after = applyBare(state, move);
  san += statusAfterMove(after);
  return san;
}

function statusAfterMove(after) {
  const check = isInCheck(after, after.turn);
  if (!check) return '';
  return legalMoves(after).length === 0 ? '#' : '+';
}

function commitMove(state, move, san) {
  const beforeFen = toFEN(state);
  const next = applyBare(state, move);
  const entry = {
    color: state.turn,
    moveNumber: state.fullmove,
    from: move.from,
    to: move.to,
    promotion: move.promotion || '',
    san,
    fenBefore: beforeFen,
    fenAfter: toFEN(next)
  };
  next.history = [...(state.history || []), entry];
  next.initialFen = state.initialFen;
  next.positionCounts = { ...(state.positionCounts || {}) };
  const key = positionKey(next);
  next.positionCounts[key] = (next.positionCounts[key] || 0) + 1;
  return next;
}

function moveWithSan(state, move) {
  const legal = legalMoves(state);
  const actual = legal.find(m => sameMove(m, move));
  if (!actual) return null;
  const san = sanForMove(state, actual, legal);
  return { state: commitMove(state, actual, san), move: actual, san };
}

function insufficientMaterial(state) {
  const pieces = [];
  state.board.forEach((p, i) => { if (p && p.type !== 'k') pieces.push({ ...p, square: i }); });
  if (pieces.some(p => ['p','r','q'].includes(p.type))) return false;
  if (pieces.length === 0) return true;
  if (pieces.length === 1 && ['b','n'].includes(pieces[0].type)) return true;
  if (pieces.every(p => p.type === 'b')) {
    const colors = new Set(pieces.map(p => (rowOf(p.square) + colOf(p.square)) % 2));
    return colors.size === 1;
  }
  return false;
}

function gameStatus(state) {
  const legal = legalMoves(state);
  const check = isInCheck(state, state.turn);
  if (legal.length === 0) {
    if (check) return { type: 'checkmate', text: `${state.turn === 'w' ? '白方' : '黑方'}被将死，${state.turn === 'w' ? '黑方' : '白方'}获胜`, check, legal };
    return { type: 'stalemate', text: '逼和：当前方无合法着法且未被将军', check, legal };
  }
  if (state.halfmove >= 100) return { type: 'draw50', text: '和棋：五十回合规则', check, legal };
  if (insufficientMaterial(state)) return { type: 'insufficient', text: '和棋：子力不足', check, legal };
  if ((state.positionCounts?.[positionKey(state)] || 0) >= 3) return { type: 'threefold', text: '和棋：三次重复局面', check, legal };
  if (check) return { type: 'check', text: `${state.turn === 'w' ? '白方' : '黑方'}被将军`, check, legal };
  return { type: 'playing', text: `${state.turn === 'w' ? '白方' : '黑方'}走棋`, check, legal };
}

function validatePosition(state) {
  const whiteKings = state.board.filter(p => p && p.color === 'w' && p.type === 'k').length;
  const blackKings = state.board.filter(p => p && p.color === 'b' && p.type === 'k').length;
  if (whiteKings !== 1 || blackKings !== 1) return '棋盘上必须且只能有一个白王和一个黑王。';
  if (isInCheck(state, opposite(state.turn))) return '非法局面：未轮到走棋的一方不能已经处于被将军状态。';
  if (legalMoves(state).length === 0 && !isInCheck(state, state.turn)) return '该初始局面已经是逼和，可调整后再开始。';
  return '';
}

function storageGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch (error) {
    console.warn(`[Chess] 无法读取本地缓存 ${key}:`, error);
    return fallback;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`[Chess] 无法写入本地缓存 ${key}:`, error);
    return false;
  }
}
function storageRemove(key) {
  try { localStorage.removeItem(key); return true; }
  catch (error) { console.warn(`[Chess] 无法删除本地缓存 ${key}:`, error); return false; }
}

function nowISO() { return new Date().toISOString(); }
function dateLabel(value) {
  try { return new Date(value || Date.now()).toLocaleString(); } catch { return ''; }
}
function colorName(color) { return color === 'w' ? '白方' : '黑方'; }
function gameModeLabel(mode) { return mode === 'ai' ? 'AI 对弈' : '双人对弈'; }
function gameStatusLabel(game) {
  if (!game) return '未知';
  if (game.status === 'ongoing') return '未完成，可继续';
  return game.resultText || (game.result ? `已结束 · ${game.result}` : '已结束');
}
function moveCountOfGame(game) {
  const history = game?.state?.history;
  return Array.isArray(history) ? history.length : 0;
}
function getGameById(id) { return app.games.find(game => game.id === id); }
function getGameState(game) {
  if (!game) return createState();
  try { return unpackState(game.state || { fen: game.currentFen || game.initialFen || INITIAL_FEN, initialFen: game.initialFen || INITIAL_FEN, history: game.history || [] }); }
  catch { return createState(game.initialFen || INITIAL_FEN); }
}
function setGameState(game, state) {
  if (!game || !state) return;
  game.initialFen = state.initialFen || game.initialFen || INITIAL_FEN;
  game.state = packState(state);
  game.updatedAt = nowISO();
}
function normalizeGameRecord(game) {
  if (!game || typeof game !== 'object') return null;
  const now = nowISO();
  const id = game.id || ('game_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
  const mode = game.mode === 'ai' ? 'ai' : 'double';
  let statePack = game.state;
  try {
    const state = getGameState({ ...game, state: statePack });
    statePack = packState(state);
  } catch {
    const state = createState(game.initialFen || INITIAL_FEN);
    statePack = packState(state);
  }
  const playerColor = game.playerColor === 'b' ? 'b' : 'w';
  const legacyAIUndoAvailable = mode === 'ai'
    && Array.isArray(statePack.history)
    && statePack.history.some(entry => entry?.color === playerColor);
  return {
    id,
    mode,
    name: String(game.name || (mode === 'ai' ? 'AI 对局' : '双人对局')).slice(0, 80),
    createdAt: game.createdAt || now,
    updatedAt: game.updatedAt || game.createdAt || now,
    initialFen: game.initialFen || statePack.initialFen || INITIAL_FEN,
    state: statePack,
    status: game.status === 'completed' || game.status === 'ongoing' ? game.status : 'ongoing',
    result: game.result || '',
    resultText: game.resultText || '',
    finishedAt: game.finishedAt || '',
    playerColor,
    aiColor: game.aiColor === 'w' ? 'w' : 'b',
    aiUndoAvailable: mode === 'ai'
      ? (typeof game.aiUndoAvailable === 'boolean' ? game.aiUndoAvailable : legacyAIUndoAvailable)
      : false,
    engineDepth: normalizeEngineDepth(game.engineDepth),
    viewMode: game.viewMode === 'real' ? 'real' : 'same'
  };
}
function createGameRecord({ mode = 'double', state = createState(), name = '', playerColor = 'w', engineDepth = AI_DEFAULT_DEPTH, viewMode = 'same' } = {}) {
  const time = nowISO();
  const safeMode = mode === 'ai' ? 'ai' : 'double';
  const safeName = String(name || `${safeMode === 'ai' ? 'AI 对局' : '双人对局'} ${new Date().toLocaleString()}`).trim().slice(0, 80);
  return normalizeGameRecord({
    id: 'game_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9),
    mode: safeMode,
    name: safeName,
    createdAt: time,
    updatedAt: time,
    initialFen: state.initialFen || toFEN(state),
    state: packState(state),
    status: 'ongoing',
    result: '',
    resultText: '',
    playerColor: playerColor === 'b' ? 'b' : 'w',
    aiColor: playerColor === 'b' ? 'w' : 'b',
    aiUndoAvailable: false,
    engineDepth: normalizeEngineDepth(engineDepth),
    viewMode
  });
}
function saveGames() { storageSet(STORAGE.games, app.games); }
function saveLevels() { storageSet(STORAGE.levels, app.levels); }
function saveActiveChallenge() {
  if (!app.challenge) return storageRemove(STORAGE.activeChallenge);
  storageSet(STORAGE.activeChallenge, {
    level: app.challenge.level,
    state: packState(app.challenge.state),
    index: app.challenge.index,
    message: app.challenge.message,
    passed: app.challenge.passed,
    official: app.challenge.official
  });
}
function terminalResultForStatus(status) {
  if (!status) return null;
  if (status.type === 'checkmate') {
    return { status: 'completed', result: status.text.includes('黑方获胜') ? '0-1' : '1-0', resultText: status.text };
  }
  if (['stalemate','draw50','insufficient','threefold'].includes(status.type)) {
    return { status: 'completed', result: '1/2-1/2', resultText: status.text };
  }
  return null;
}
function syncGameTerminalStatus(game, state) {
  if (!game || game.status !== 'ongoing') return;
  const status = gameStatus(state);
  const terminal = terminalResultForStatus(status);
  if (terminal) {
    game.status = terminal.status;
    game.result = terminal.result;
    game.resultText = terminal.resultText;
    game.finishedAt = nowISO();
  }
}
function saveDouble() {
  if (!app.play) return;
  if (!app.play.gameId) ensureActiveDoubleGame();
  const game = getGameById(app.play.gameId);
  if (game) {
    game.viewMode = app.play.viewMode === 'real' ? 'real' : 'same';
    setGameState(game, app.play.state);
    syncGameTerminalStatus(game, app.play.state);
    saveGames();
    storageSet(STORAGE.activeDoubleGame, game.id);
  }
  storageSet(STORAGE.double, { state: packState(app.play.state), viewMode: app.play.viewMode });
}
function saveAI() {
  if (!app.ai) return;
  const game = getGameById(app.ai.gameId);
  if (game) {
    game.playerColor = app.ai.playerColor === 'b' ? 'b' : 'w';
    game.aiColor = opposite(game.playerColor);
    game.engineDepth = normalizeEngineDepth(app.ai.engineDepth);
    game.aiUndoAvailable = app.ai.undoAvailable === true;
    setGameState(game, app.ai.state);
    syncGameTerminalStatus(game, app.ai.state);
    saveGames();
    storageSet(STORAGE.activeAIGame, game.id);
  }
}
function ensureActiveDoubleGame() {
  if (!app.play) app.play = { gameId: '', state: createState(), viewMode: 'same' };
  const existing = getGameById(app.play.gameId);
  if (existing) return existing;
  const record = createGameRecord({ mode: 'double', state: app.play.state || createState(), viewMode: app.play.viewMode || 'same' });
  app.games.unshift(record);
  app.play.gameId = record.id;
  storageSet(STORAGE.activeDoubleGame, record.id);
  saveGames();
  return record;
}
function startNewDoubleGame(state = createState(), name = '') {
  const record = createGameRecord({ mode: 'double', state, name, viewMode: app.play?.viewMode || 'same' });
  app.games.unshift(record);
  app.play = { gameId: record.id, state, viewMode: record.viewMode };
  storageSet(STORAGE.activeDoubleGame, record.id);
  saveDouble();
  app.view = 'double';
  app.selected = null;
}
function recordToAI(game) {
  const state = getGameState(game);
  const playerColor = game.playerColor === 'b' ? 'b' : 'w';
  return {
    gameId: game.id,
    state,
    playerColor,
    aiColor: opposite(playerColor),
    engineDepth: normalizeEngineDepth(game.engineDepth),
    pending: false,
    message: '',
    analysis: null,
    errorFen: '',
    requestToken: '',
    undoAvailable: game.aiUndoAvailable === true
  };
}
function startNewAIGame(playerColor = 'w', engineDepth = AI_DEFAULT_DEPTH, name = '') {
  const state = createState();
  const record = createGameRecord({ mode: 'ai', state, name, playerColor, engineDepth });
  app.games.unshift(record);
  app.ai = recordToAI(record);
  storageSet(STORAGE.activeAIGame, record.id);
  saveAI();
  app.view = 'ai';
  app.selected = null;
  render();
  maybeRequestAIMove();
}
function setManualGameResult(game, result, resultText) {
  if (!game) return;
  game.status = 'completed';
  game.result = result;
  game.resultText = resultText;
  game.finishedAt = nowISO();
  game.updatedAt = nowISO();
  saveGames();
}
function gameLibraryStats() {
  const total = app.games.length;
  const ongoing = app.games.filter(g => g.status === 'ongoing').length;
  const ai = app.games.filter(g => g.mode === 'ai').length;
  const double = app.games.filter(g => g.mode === 'double').length;
  return { total, ongoing, ai, double };
}
function sortedGames() {
  return [...app.games].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function gameNameInputValue() {
  return `棋局 ${new Date().toLocaleString()}`;
}
function isGameOngoing(game) { return game && game.status === 'ongoing'; }
function canReplayGame(game, state = null) {
  if (!game || game.status !== 'completed') return false;
  const history = state?.history || getGameState(game).history;
  return Array.isArray(history) && history.length > 0;
}

function loadData() {
  const storedLevels = storageGet(STORAGE.levels, []);
  const storedGames = storageGet(STORAGE.games, []);
  app.levels = Array.isArray(storedLevels) ? storedLevels.filter(level => level && typeof level === 'object') : [];
  app.games = (Array.isArray(storedGames) ? storedGames : []).map(normalizeGameRecord).filter(Boolean);

  const packed = storageGet(STORAGE.double, null);
  if (!app.games.some(g => g.mode === 'double') && packed?.state) {
    try {
      const migratedState = unpackState(packed.state);
      const migrated = createGameRecord({ mode: 'double', state: migratedState, name: '已保存的双人对局', viewMode: packed.viewMode || 'same' });
      app.games.unshift(migrated);
      storageSet(STORAGE.activeDoubleGame, migrated.id);
      saveGames();
    } catch {}
  }

  const activeDoubleId = storageGet(STORAGE.activeDoubleGame, '');
  let doubleGame = app.games.find(g => g.mode === 'double' && g.id === activeDoubleId)
    || app.games.find(g => g.mode === 'double' && g.status === 'ongoing')
    || app.games.find(g => g.mode === 'double');
  if (doubleGame) app.play = { gameId: doubleGame.id, state: getGameState(doubleGame), viewMode: doubleGame.viewMode || 'same' };
  else app.play = { gameId: '', state: createState(), viewMode: 'same' };

  const activeAIId = storageGet(STORAGE.activeAIGame, '');
  const aiGame = app.games.find(g => g.mode === 'ai' && g.id === activeAIId)
    || app.games.find(g => g.mode === 'ai' && g.status === 'ongoing');
  app.ai = aiGame ? recordToAI(aiGame) : null;

  const active = storageGet(STORAGE.activeChallenge, null);
  if (active?.level && active?.state) {
    try {
      app.challenge = {
        level: active.level,
        state: unpackState(active.state),
        index: active.index || 0,
        pending: false,
        message: active.message || '',
        passed: !!active.passed,
        official: !!active.official
      };
    } catch { app.challenge = null; }
  }
}

function activeChallengeKey(ch = app.challenge) {
  if (!ch || !ch.level) return '';
  if (ch.official) return 'official:' + (ch.level.officialFile || ch.level.id || ch.level.name || '');
  return 'local:' + (ch.level.id || '');
}

function localChallengeExists(ch = app.challenge) {
  return !!(ch?.level?.id && app.levels.some(level => level.id === ch.level.id));
}

function canResumeActiveChallenge() {
  const ch = app.challenge;
  if (!ch || ch.passed) return false;
  if (!ch.official) return localChallengeExists(ch);
  const key = activeChallengeKey(ch);
  return !!key && app.activeChallengeKey === key && app.activeChallengeAvailable === true;
}

function verifyActiveChallengeAvailability() {
  const ch = app.challenge;
  if (!ch || ch.passed) return;
  if (!ch.official) return;
  const key = activeChallengeKey(ch);
  if (!key) return;
  if (app.activeChallengeKey === key && app.activeChallengeAvailable !== null) return;
  app.activeChallengeKey = key;
  app.activeChallengeAvailable = false;
  const file = ch.level.officialFile || String(ch.level.id || '').replace(/^official_/, '');
  if (!file) return;
  fetch(officialFileUrl(file), { cache: 'no-store' })
    .then(res => {
      if (activeChallengeKey(app.challenge) !== key) return;
      app.activeChallengeAvailable = !!res.ok;
      if (app.view === 'home') render();
    })
    .catch(() => {
      if (activeChallengeKey(app.challenge) !== key) return;
      app.activeChallengeAvailable = false;
      if (app.view === 'home') render();
    });
}

function render() {
  updateIsland();
  if (app.view !== 'setup') app.selected = (app.view === 'challenge' && app.challenge?.pending) || (app.view === 'ai' && app.ai?.pending) ? null : app.selected;
  if (app.view === 'home') return renderHome();
  if (app.view === 'double') return renderDouble();
  if (app.view === 'ai') return renderAI();
  if (app.view === 'games') return renderGames();
  if (app.view === 'replay') return renderReplay();
  if (app.view === 'levels') return renderLevels();
  if (app.view === 'create') return renderCreateIntro();
  if (app.view === 'setup') return renderSetup();
  if (app.view === 'creator-record') return renderCreatorRecord();
  if (app.view === 'challenge') return renderChallenge();
}

function renderHome() {
  const stats = gameLibraryStats();
  const savedMoves = app.play?.state?.history?.length || 0;
  const localCount = app.levels.length;
  const recent = app.challenge ? htmlEscape(app.challenge.level.name) + (app.challenge.passed ? '（已通过）' : '（未完成）') : '暂无';
  verifyActiveChallengeAvailability();
  const activeChallengeText = canResumeActiveChallenge() ? '<button class="ok" data-action="resume-challenge">继续上次挑战</button>' : '';
  const activeAIText = app.ai && getGameById(app.ai.gameId)?.status === 'ongoing' ? '<button class="ok" data-action="open-ai">继续 AI 对局</button>' : '<button data-action="open-ai">AI 对弈</button>';
  $app.innerHTML = `
    <section class="hero">
      <div class="card hero-card">
        <div class="hero-eyebrow">
          <span class="badge">♟ Chess</span>
          <span class="badge official">云端 Stockfish</span>
        </div>
        <h2 class="hero-title">随时开局，<br><span>复盘与训练</span></h2>
        <p class="hero-copy">支持双人对弈、AI 对弈、官方谜题、个人谜题与本地棋局库。对局复盘可调用云端 Stockfish API 对当前局面实时分析。</p>
        <div class="action-grid">
          <button data-action="open-double">开始对弈</button>
          ${activeAIText}
          <button data-action="open-games">棋局库 / 复盘</button>
          <button data-action="open-levels">练习官方谜题</button>
          <button class="secondary" data-action="new-standard-double">标准双人新局</button>
          <button class="secondary" data-action="open-create">创建谜题</button>
          ${activeChallengeText}
        </div>
        <div class="feature-list">
          <div class="feature"><span class="feature-dot"></span><span><b>云端引擎：</b>AI 对弈与复盘分析均通过在线 Stockfish API 请求计算，不使用本地预分析结果。</span></div>
          <div class="feature"><span class="feature-dot"></span><span><b>本地棋库：</b>双人、AI 对局会保存在浏览器 localStorage，刷新或关闭窗口后仍可继续未完成对局。</span></div>
          <div class="feature"><span class="feature-dot"></span><span><b>谜题训练：</b>官方题库不暴露答案；个人谜题可查看解法与加密导入导出。</span></div>
        </div>
      </div>
      <div class="card">
        <div class="panel-title"><h3>我的棋局</h3><span class="badge">本地数据</span></div>
        <div class="stat-grid">
          <div class="stat-card"><strong>${stats.total}</strong><span>全部棋局</span></div>
          <div class="stat-card"><strong>${stats.ongoing}</strong><span>未完成棋局</span></div>
          <div class="stat-card"><strong>${savedMoves}</strong><span>当前双人步数</span></div>
          <div class="stat-card"><strong>${localCount}</strong><span>我的谜题</span></div>
        </div>
        <div class="feature-list">
          <div class="feature"><span class="feature-dot"></span><span><b>最近挑战：</b>${recent}</span></div>
          <div class="feature"><span class="feature-dot"></span><span><b>复盘分析：</b>棋局结束后可在棋局库中逐步复盘，并获取候选着法、胜率、评价与主变；未完成棋局不可启动分析。</span></div>
        </div>
        <div class="official-note">官方谜题版权标注：<strong>谜题编创者版权所有</strong>。官方谜题不显示正确解答。</div>
      </div>
    </section>`;
}

function statusClass(status) {
  if (status.type === 'check') return 'check';
  if (['checkmate','stalemate','draw50','insufficient','threefold'].includes(status.type)) return 'done';
  return '';
}

function renderDouble() {
  ensureActiveDoubleGame();
  const state = app.play.state;
  const game = getGameById(app.play.gameId);
  const status = gameStatus(state);
  const manualDone = game && game.status !== 'ongoing';
  const statusText = manualDone ? gameStatusLabel(game) : status.text;
  const statusType = manualDone ? 'done' : statusClass(status);
  const locked = manualDone || terminalResultForStatus(status);
  const replayAvailable = canReplayGame(game, state);
  $app.innerHTML = `
    <section class="layout">
      <div class="board-wrap">
        <div class="toolbar">
          <div class="toolbar-left">
            <span class="status-pill ${statusType}">${htmlEscape(statusText)}</span>
            <span class="status-pill">${htmlEscape(game?.name || '双人对局')}</span>
          </div>
          <div class="toolbar-right">
            <select id="viewModeSelect" aria-label="棋子显示方向" ${manualDone ? 'disabled' : ''}>
              <option value="same" ${app.play.viewMode === 'same' ? 'selected' : ''}>黑白方同向看屏幕</option>
              <option value="real" ${app.play.viewMode === 'real' ? 'selected' : ''}>模拟真实棋盘</option>
            </select>
          </div>
        </div>
        ${boardHTML(state, { context: 'double', invertBlack: app.play.viewMode === 'real', flip: false })}
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>双人模式</h2><span class="badge">本地棋局</span></div>
        <div class="toolbar-left compact-actions">
          <button data-action="new-standard-double">标准新局</button>
          <button class="secondary" data-action="start-setup-double">自定义新局</button>
          <button class="secondary" data-action="rename-game" data-game-id="${htmlEscape(game?.id || '')}">修改名称</button>
          <button class="ghost" data-action="open-replay" data-game-id="${htmlEscape(game?.id || '')}" ${replayAvailable ? '' : 'disabled'} title="${replayAvailable ? '复盘已结束棋局' : '棋局结束后方可复盘'}">复盘</button>
        </div>
        <div class="toolbar-left compact-actions">
          <button class="ghost" data-action="undo-double" ${state.history.length && !locked ? '' : 'disabled'}>悔棋一步</button>
          <button class="secondary" data-action="offer-draw-double" ${!locked ? '' : 'disabled'}>和棋</button>
          <button class="danger" data-action="resign-double" ${!locked ? '' : 'disabled'}>认输</button>
          <button class="secondary" data-action="open-games">棋局库</button>
        </div>
        ${moveLogHTML(state.history)}
        <div class="empty-state">双人模式会自动保存到本地棋局库。和棋与认输需要二次确认；未完成棋局关闭窗口后仍可继续。</div>
      </aside>
    </section>`;
}


function canUndoAIMove(ai = app.ai) {
  const game = ai ? getGameById(ai.gameId) : null;
  return !!(
    ai
    && game?.status === 'ongoing'
    && ai.undoAvailable
    && !ai.pending
    && lastPlayerMoveIndex(ai.state, ai.playerColor) >= 0
  );
}

function renderAI() {
  const game = app.ai ? getGameById(app.ai.gameId) : null;
  if (!app.ai || !game) return renderAISetup();
  const state = app.ai.state;
  const status = game.status === 'ongoing' ? gameStatus(state) : null;
  const locked = game.status !== 'ongoing' || app.ai.pending || terminalResultForStatus(status);
  const statusText = game.status === 'ongoing'
    ? (app.ai.pending ? 'AI 云端计算中……' : (app.ai.message || (state.turn === app.ai.playerColor ? '轮到你走棋' : '等待 AI 走棋')))
    : gameStatusLabel(game);
  const statusType = game.status !== 'ongoing' ? 'done' : (app.ai.message?.includes('失败') || app.ai.message?.includes('不可用') ? 'error' : statusClass(status));
  const replayAvailable = canReplayGame(game, state);
  $app.innerHTML = `
    <section class="layout">
      <div class="board-wrap">
        <div class="toolbar">
          <div class="toolbar-left">
            <span class="status-pill ${statusType}">${htmlEscape(statusText)}</span>
            <span class="status-pill">你执${colorName(app.ai.playerColor)} · AI 执${colorName(app.ai.aiColor)}</span>
          </div>
        </div>
        ${boardHTML(state, { context: 'ai', invertBlack: false, flip: app.ai.playerColor === 'b' })}
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>${htmlEscape(game.name)}</h2><span class="badge">云端 Stockfish</span></div>
        <div class="toolbar-left compact-actions">
          <button data-action="new-ai-setup">新建 AI 对局</button>
          <button class="secondary" data-action="rename-game" data-game-id="${htmlEscape(game.id)}">修改名称</button>
          <button class="ghost" data-action="open-replay" data-game-id="${htmlEscape(game.id)}" ${replayAvailable ? '' : 'disabled'} title="${replayAvailable ? '复盘已结束棋局' : '棋局结束后方可复盘'}">复盘分析</button>
          <button class="secondary" data-action="open-games">棋局库</button>
        </div>
        <div class="toolbar-left compact-actions">
          <button class="ghost" data-action="undo-ai" ${canUndoAIMove(app.ai) ? '' : 'disabled'}>悔棋一步</button>
          <button class="danger" data-action="resign-ai" ${!locked ? '' : 'disabled'}>认输</button>
          <button class="secondary" data-action="retry-ai-move" ${game.status === 'ongoing' && state.turn === app.ai.aiColor && !app.ai.pending ? '' : 'disabled'}>重试 AI 走棋</button>
        </div>
        <div class="engine-note">AI 每一步通过云端接口实时请求，仅使用 StockfishOnline 云端接口，并按所选深度实时计算。悔棋会回到玩家最近一次落子之前；每次重新落子后仅可悔棋一次，AI 计算与落子期间不可悔棋，接口失败且 AI 未落子时仍可撤销玩家刚才的着法。</div>
        ${moveLogHTML(state.history)}
      </aside>
    </section>`;
  if (game.status === 'ongoing' && !app.ai.pending && state.turn === app.ai.aiColor && app.ai.errorFen !== toFEN(state)) {
    setTimeout(() => maybeRequestAIMove(), 0);
  }
}

function renderAISetup() {
  const active = app.ai ? getGameById(app.ai.gameId) : null;
  const continueButton = active && active.status === 'ongoing' ? `<button class="ok" data-action="continue-game" data-game-id="${htmlEscape(active.id)}">继续未完成 AI 对局</button>` : '';
  $app.innerHTML = `
    <section class="layout">
      <div class="card">
        <div class="hero-eyebrow"><span class="badge">AI 对弈</span><span class="badge official">StockfishOnline 云端</span></div>
        <h2>创建 AI 对局</h2>
        <p class="hero-copy">选择执棋颜色后开局。AI 着法由在线 Stockfish API 实时计算；对局自动保存到本地棋局库，未完成状态可继续。</p>
        <div class="form-grid">
          <label class="full">棋局名称
            <input id="aiGameName" maxlength="80" value="${htmlEscape(gameNameInputValue())}" />
          </label>
          <label>我方执棋
            <select id="aiPlayerColor"><option value="w">白方</option><option value="b">黑方</option></select>
          </label>
          <label>云端搜索深度
            <select id="aiEngineDepth">
              <option value="15">严格 · Depth 15</option>
              <option value="13" selected>均衡 · Depth 13</option>
              <option value="11">快速 · Depth 11</option>
            </select>
          </label>
          <div class="full switch-line">
            <button data-action="start-ai-game">开始 AI 对局</button>
            ${continueButton}
            <button class="secondary" data-action="open-games">打开棋局库</button>
          </div>
        </div>
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h3>接口说明</h3><span class="badge">无需密钥</span></div>
        <div class="feature-list">
          <div class="feature"><span class="feature-dot"></span><span>引擎接口：仅接入 StockfishOnline REST API，不再调用其他主接口。</span></div>
          <div class="feature"><span class="feature-dot"></span><span>搜索深度：提供 Depth 11、13、15 三档，复盘评价固定使用严格的 Depth 15。</span></div>
          <div class="feature"><span class="feature-dot"></span><span>浏览器必须能访问外部 HTTPS API；第三方服务宕机或网络阻断时会提示重试，不会伪造 AI 走法。</span></div>
        </div>
      </aside>
    </section>`;
}

function gameItemHTML(game) {
  const state = getGameState(game);
  const moveCount = state.history?.length || 0;
  const status = gameStatusLabel(game);
  const continueBtn = game.status === 'ongoing' ? `<button data-action="continue-game" data-game-id="${htmlEscape(game.id)}">继续</button>` : '';
  const replayAvailable = canReplayGame(game, state);
  const side = game.mode === 'ai' ? `；你执${colorName(game.playerColor)}` : '';
  return `<article class="level-item game-item">
    <header>
      <div>
        <div class="level-title">${htmlEscape(game.name)}</div>
        <div class="level-meta">${gameModeLabel(game.mode)}${side}；${status}；${moveCount} 步；更新：${dateLabel(game.updatedAt)}</div>
      </div>
      <span class="badge ${game.status === 'ongoing' ? '' : 'official'}">${game.result || (game.status === 'ongoing' ? '未完成' : '已结束')}</span>
    </header>
    <div class="level-actions">
      ${continueBtn}
      <button class="secondary" data-action="open-replay" data-game-id="${htmlEscape(game.id)}" ${replayAvailable ? '' : 'disabled'} title="${replayAvailable ? '复盘已结束棋局' : '棋局结束后方可复盘'}">复盘 / AI 分析</button>
      <button class="secondary" data-action="rename-game" data-game-id="${htmlEscape(game.id)}">修改名称</button>
      <button class="danger" data-action="delete-game" data-game-id="${htmlEscape(game.id)}">删除</button>
    </div>
  </article>`;
}

function renderGames() {
  const stats = gameLibraryStats();
  const games = sortedGames();
  $app.innerHTML = `
    <section class="layout games-layout">
      <div class="panel side-panel">
        <div class="panel-title"><h2>所有棋局库</h2><span class="badge">localStorage</span></div>
        <div class="stat-grid compact-stats">
          <div class="stat-card"><strong>${stats.total}</strong><span>全部</span></div>
          <div class="stat-card"><strong>${stats.ongoing}</strong><span>未完成</span></div>
          <div class="stat-card"><strong>${stats.ai}</strong><span>AI</span></div>
          <div class="stat-card"><strong>${stats.double}</strong><span>双人</span></div>
        </div>
        <div class="toolbar-left compact-actions">
          <button data-action="new-standard-double">新建双人局</button>
          <button data-action="new-ai-setup">新建 AI 局</button>
          <button class="secondary" data-action="home">返回首页</button>
        </div>
        <div class="empty-state">棋局记录保存在本机浏览器。换设备或清除浏览器数据后不会自动同步。</div>
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>记录列表</h2><span class="badge">可继续 / 复盘 / 改名</span></div>
        <div class="game-list-scroll">
          ${games.length ? games.map(gameItemHTML).join('') : '<div class="empty-state">暂无棋局。开始双人或 AI 对局后会自动记录在这里。</div>'}
        </div>
      </aside>
    </section>`;
}

function getReplayState() {
  const rp = app.replay;
  const game = rp ? getGameById(rp.gameId) : null;
  if (!game) return null;
  const full = getGameState(game);
  const history = (full.history || []).slice(0, rp.stepIndex);
  return rebuildStateFromHistory(full.initialFen || game.initialFen || INITIAL_FEN, history);
}

function replayMoveLabel(state, uci) {
  if (!uci) return '—';
  const move = legalMoveFromUCI(state, uci);
  if (!move) return htmlEscape(uci || '—');
  try { return htmlEscape(sanForMove(state, move, legalMoves(state))); } catch { return htmlEscape(uci || '—'); }
}

function evalText(line) {
  if (!line) return '—';
  if (line.mate !== null && line.mate !== undefined && line.mate !== '') {
    const mate = Number(line.mate);
    if (Number.isFinite(mate)) return mate === 0 ? '将死' : `${mate > 0 ? '+' : '-'}M${Math.abs(mate)}`;
  }
  const val = Number(line.eval ?? line.evaluation);
  if (!Number.isFinite(val)) return '—';
  return val > 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
}

function winChanceText(line) {
  const val = Number(line?.winChance);
  if (!Number.isFinite(val)) return '';
  return `${Math.max(0, Math.min(100, val)).toFixed(1)}% 白方胜率`;
}

function uciFromHistoryEntry(entry) {
  if (!entry || !Number.isInteger(Number(entry.from)) || !Number.isInteger(Number(entry.to))) return '';
  return `${squareName(Number(entry.from))}${squareName(Number(entry.to))}${entry.promotion || ''}`.toLowerCase();
}

function analysisScoreForWhite(analysis) {
  if (!analysis) return 0;
  const mate = Number(analysis.mate);
  if (analysis.mate !== null && analysis.mate !== undefined && analysis.mate !== '' && Number.isFinite(mate)) {
    if (mate === 0) {
      const raw = Number(analysis.eval);
      return Number.isFinite(raw) ? raw : 0;
    }
    return Math.sign(mate) * (100 - Math.min(80, Math.abs(mate)) * 0.5);
  }
  const value = Number(analysis.eval);
  return Number.isFinite(value) ? value : 0;
}

function classifyMoveQuality({ mover, actualUci, bestUci, beforeAnalysis, afterAnalysis }) {
  const before = analysisScoreForWhite(beforeAnalysis);
  const after = analysisScoreForWhite(afterAnalysis);
  const rawLoss = mover === 'w' ? before - after : after - before;
  const loss = Math.max(0, Number.isFinite(rawLoss) ? rawLoss : 0);
  const isBest = !!actualUci && cleanBestMove(actualUci) === cleanBestMove(bestUci);
  let symbol = '✓', label = '良好', tone = 'good';
  if (isBest || loss <= 0.10) { symbol = '!'; label = isBest ? '最佳着法' : '精准着法'; tone = 'excellent'; }
  else if (loss <= 0.40) { symbol = '✓'; label = '优秀'; tone = 'good'; }
  else if (loss <= 0.90) { symbol = '?!'; label = '值得商榷'; tone = 'inaccuracy'; }
  else if (loss <= 2.00) { symbol = '?'; label = '失误'; tone = 'mistake'; }
  else { symbol = '??'; label = '严重失误'; tone = 'blunder'; }
  return { symbol, label, tone, loss, isBest, before, after };
}

function buildMoveReview(beforeState, entry, beforeAnalysis, afterAnalysis) {
  if (!beforeState || !entry || !beforeAnalysis || !afterAnalysis) return null;
  const actualUci = uciFromHistoryEntry(entry);
  const bestUci = cleanBestMove(beforeAnalysis.bestMove);
  const quality = classifyMoveQuality({
    mover: entry.color,
    actualUci,
    bestUci,
    beforeAnalysis,
    afterAnalysis
  });
  return {
    ...quality,
    actualUci,
    actualSan: entry.san || replayMoveLabel(beforeState, actualUci),
    bestUci,
    bestSan: bestUci ? replayMoveLabel(beforeState, bestUci) : '—',
    mover: entry.color,
    depth: AI_REVIEW_DEPTH
  };
}

function moveReviewHTML(review) {
  if (!review) return '';
  return `<div class="move-review-card ${htmlEscape(review.tone)}">
    <div class="move-review-symbol">${htmlEscape(review.symbol)}</div>
    <div class="move-review-copy">
      <div class="move-review-title">本步评价：${htmlEscape(review.label)}</div>
      <div class="move-review-meta">实战 ${htmlEscape(review.actualSan || review.actualUci || '—')} · 引擎建议 ${htmlEscape(review.bestSan || review.bestUci || '—')}</div>
      <div class="move-review-meta">评价 ${htmlEscape(evalText({ eval: review.before }))} → ${htmlEscape(evalText({ eval: review.after }))} · 近似损失 ${review.loss.toFixed(2)} 兵</div>
    </div>
  </div>`;
}

function analysisPanelHTML(state) {
  const rp = app.replay;
  if (!rp) return '';
  if (rp.pending) return '<div class="analysis-panel"><h3>AI 实时分析</h3><div class="empty-state"><span class="loading-orb"></span>StockfishOnline 正在以 Depth 15 严格计算当前局面与本步质量……</div></div>';
  if (rp.error) return `<div class="analysis-panel"><h3>AI 实时分析</h3><div class="empty-state error-text">${htmlEscape(rp.error)}</div><button class="secondary" data-action="refresh-replay-analysis">重新分析</button></div>`;
  const data = rp.analysis;
  if (!data) return '<div class="analysis-panel"><h3>AI 实时分析</h3><div class="empty-state">准备分析当前局面。</div></div>';
  const best = data.lines?.[0] || data;
  const win = Number(best.winChance);
  const barWidth = Number.isFinite(win) ? Math.max(2, Math.min(98, win)) : 50;
  const lines = (data.lines || []).slice(0, 1).map((line, i) => {
    const continuation = Array.isArray(line.continuation) ? line.continuation.join(' ') : (line.continuation || '');
    return `<div class="analysis-line">
      <span class="line-no">#${i + 1}</span>
      <span class="line-move">${replayMoveLabel(state, line.move || line.bestMove)}</span>
      <span class="line-eval">${htmlEscape(evalText(line))}</span>
      <span class="line-depth">D${htmlEscape(line.depth || data.depth || '')}</span>
      <small>${htmlEscape(continuation)}</small>
    </div>`;
  }).join('');
  const terminalText = data.terminal ? `<div><b>终局：</b>${htmlEscape(data.statusText || '对局已结束')}</div>` : '';
  return `<div class="analysis-panel">
    <div class="panel-title"><h3>AI 实时分析</h3><span class="badge">${htmlEscape(data.source || 'StockfishOnline')}</span></div>
    ${moveReviewHTML(rp.moveReview)}
    <div class="eval-summary">
      <div><b>最佳着法：</b>${data.bestMove ? replayMoveLabel(state, best.move || data.bestMove) : '—'}</div>
      <div><b>局面评价：</b>${htmlEscape(evalText(best))} ${winChanceText(best) ? ' · ' + htmlEscape(winChanceText(best)) : ''}</div>
      <div><b>搜索：</b>Depth ${htmlEscape(best.depth || data.depth || AI_REVIEW_DEPTH)} · ${htmlEscape(data.calculatedAt ? dateLabel(data.calculatedAt) : '')}${data.cached ? ' · 精确缓存' : ''}</div>
      ${terminalText}
    </div>
    <div class="eval-bar" aria-label="白方胜率"><span style="width:${barWidth}%"></span></div>
    <div class="analysis-lines">${lines || '<div class="empty-state">当前局面没有可执行的候选着法。</div>'}</div>
    <div class="toolbar-left"><button class="secondary" data-action="refresh-replay-analysis">刷新当前局面分析</button></div>
  </div>`;
}

function renderReplay() {
  const rp = app.replay;
  const game = rp ? getGameById(rp.gameId) : null;
  if (!rp || !game || game.status !== 'completed') {
    app.replay = null;
    app.view = 'games';
    return renderGames();
  }
  const full = getGameState(game);
  const total = full.history?.length || 0;
  rp.stepIndex = Math.max(0, Math.min(total, rp.stepIndex));
  const state = getReplayState();
  const fen = toFEN(state);
  const currentMove = rp.stepIndex > 0 ? full.history[rp.stepIndex - 1] : null;
  const flip = game.mode === 'ai' && game.playerColor === 'b';
  const invertBlack = game.mode === 'double' && game.viewMode === 'real';
  const signature = `${game.id}|${rp.stepIndex}|${fen}`;
  if (!rp.error && rp.analysisSignature !== signature && rp.pendingSignature !== signature) {
    rp.pending = true;
    rp.pendingSignature = signature;
    rp.error = '';
    rp.analysis = null;
    rp.moveReview = null;
    const token = uid();
    rp.requestToken = token;
    const forceRefresh = !!rp.forceRefresh;
    rp.forceRefresh = false;
    setTimeout(() => runReplayAnalysis(fen, rp.stepIndex, signature, token, forceRefresh), 0);
  }
  $app.innerHTML = `
    <section class="layout replay-layout">
      <div class="board-wrap">
        <div class="toolbar">
          <div class="toolbar-left">
            <span class="status-pill">复盘：${htmlEscape(game.name)}</span>
            <span class="status-pill">第 ${rp.stepIndex} / ${total} 步</span>
          </div>
        </div>
        ${boardHTML(state, { context: 'replay', invertBlack, flip, noInteraction: true })}
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>复盘与 AI 分析</h2><span class="badge">Depth 15 严格分析</span></div>
        <div class="solution-viewer-controls replay-controls">
          <span class="step-san">${htmlEscape(currentMove ? `${currentMove.moveNumber}. ${currentMove.san}` : '初始局面')}</span>
          <button data-action="replay-goto-start" ${rp.stepIndex === 0 ? 'disabled' : ''}>⏮ 初始</button>
          <button data-action="replay-prev" ${rp.stepIndex === 0 ? 'disabled' : ''}>◀ 上一步</button>
          <button data-action="replay-next" ${rp.stepIndex >= total ? 'disabled' : ''}>下一步 ▶</button>
          <button data-action="replay-goto-end" ${rp.stepIndex >= total ? 'disabled' : ''}>最终 ⏭</button>
        </div>
        ${analysisPanelHTML(state)}
        ${moveLogHTML(full.history, rp.reviews)}
        <div class="toolbar-left compact-actions">
          ${game.status === 'ongoing' ? `<button data-action="continue-game" data-game-id="${htmlEscape(game.id)}">继续此局</button>` : ''}
          <button class="secondary" data-action="open-games">返回棋局库</button>
        </div>
      </aside>
    </section>`;
}

function replayGoto(index) {
  if (!app.replay) return;
  const game = getGameById(app.replay.gameId);
  const total = game ? (getGameState(game).history?.length || 0) : 0;
  app.replay.stepIndex = Math.max(0, Math.min(total, index));
  app.replay.requestToken = uid();
  app.replay.analysis = null;
  app.replay.moveReview = null;
  app.replay.analysisSignature = '';
  app.replay.pendingSignature = '';
  app.replay.pending = false;
  app.replay.error = '';
  render();
}
function replayStep(delta) { replayGoto((app.replay?.stepIndex || 0) + delta); }

async function runReplayAnalysis(fen, stepIndex, signature, token, forceRefresh = false) {
  const rp = app.replay;
  const game = rp ? getGameById(rp.gameId) : null;
  if (!rp || !game || game.status !== 'completed' || rp.pendingSignature !== signature || rp.requestToken !== token) return;
  try {
    const full = getGameState(game);
    const currentPromise = requestCloudAnalysis(fen, { depth: AI_REVIEW_DEPTH, forceRefresh });
    let moveReview = null;
    let currentAnalysis;
    if (stepIndex > 0) {
      const beforeState = rebuildStateFromHistory(full.initialFen || game.initialFen || INITIAL_FEN, (full.history || []).slice(0, stepIndex - 1));
      const beforeFen = toFEN(beforeState);
      const [beforeAnalysis, afterAnalysis] = await Promise.all([
        requestCloudAnalysis(beforeFen, { depth: AI_REVIEW_DEPTH, forceRefresh }),
        currentPromise
      ]);
      currentAnalysis = afterAnalysis;
      moveReview = buildMoveReview(beforeState, full.history[stepIndex - 1], beforeAnalysis, afterAnalysis);
    } else {
      currentAnalysis = await currentPromise;
    }
    if (!app.replay || app.replay.pendingSignature !== signature || app.replay.requestToken !== token) return;
    app.replay.analysis = currentAnalysis;
    app.replay.moveReview = moveReview;
    app.replay.analysisSignature = signature;
    app.replay.pending = false;
    app.replay.pendingSignature = '';
    app.replay.error = '';
    if (moveReview) app.replay.reviews[stepIndex] = moveReview;
    if (app.view === 'replay') render();
  } catch (err) {
    if (!app.replay || app.replay.pendingSignature !== signature || app.replay.requestToken !== token) return;
    app.replay.pending = false;
    app.replay.pendingSignature = '';
    app.replay.error = 'AI 分析接口暂不可用：' + (err?.message || err);
    if (app.view === 'replay') render();
  }
}

function openReplay(gameId) {
  const game = getGameById(gameId);
  if (!game) return showToast('未找到该棋局。');
  if (game.status !== 'completed') return showToast('棋局尚未结束，暂不可进行复盘或 AI 分析。');
  const total = getGameState(game).history?.length || 0;
  if (!total) return showToast('该棋局暂无可复盘着法。');
  app.replay = {
    gameId,
    stepIndex: total,
    analysis: null,
    moveReview: null,
    reviews: {},
    analysisSignature: '',
    pending: false,
    pendingSignature: '',
    requestToken: '',
    forceRefresh: false,
    error: ''
  };
  app.view = 'replay';
  app.selected = null;
  render();
}

function continueGame(gameId) {
  const game = getGameById(gameId);
  if (!game) return showToast('未找到该棋局。');
  if (game.mode === 'ai') {
    app.ai = recordToAI(game);
    storageSet(STORAGE.activeAIGame, game.id);
    app.view = 'ai';
  } else {
    app.play = { gameId: game.id, state: getGameState(game), viewMode: game.viewMode || 'same' };
    storageSet(STORAGE.activeDoubleGame, game.id);
    app.view = 'double';
  }
  app.replay = null;
  app.selected = null;
  render();
}

function cleanBestMove(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/^bestmove\s+/i, '').split(/\s+/)[0];
  if (text === '(none)' || text === '0000') return '';
  return text.toLowerCase();
}
function uciMoveParts(uci) {
  const move = cleanBestMove(uci);
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return null;
  return { from: squareToIndex(move.slice(0, 2)), to: squareToIndex(move.slice(2, 4)), promotion: move[4] || '' };
}
function legalMoveFromUCI(state, uci) {
  const parts = uciMoveParts(uci);
  if (!parts) return null;
  return legalMoves(state).find(m => Number(m.from) === parts.from && Number(m.to) === parts.to && ((m.promotion || '') === (parts.promotion || ''))) || null;
}
function normalizeContinuation(value) {
  if (Array.isArray(value)) return value.map(cleanBestMove).filter(Boolean);
  return String(value || '').split(/\s+/).map(cleanBestMove).filter(Boolean);
}
function winChanceFromEvaluation(evaluation, mate) {
  const mateNumber = Number(mate);
  if (mate !== null && mate !== undefined && mate !== '' && Number.isFinite(mateNumber)) {
    if (mateNumber > 0) return 100;
    if (mateNumber < 0) return 0;
  }
  const value = Number(evaluation);
  if (!Number.isFinite(value)) return 50;
  const centipawns = Math.max(-1200, Math.min(1200, value * 100));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * centipawns)) - 1);
}
function normalizeEngineLine(item = {}, source = '', depth = AI_DEFAULT_DEPTH) {
  const coordinateMove = item.from && item.to ? `${item.from}${item.to}${item.promotion || ''}` : '';
  const move = cleanBestMove(item.move || item.lan || item.bestmove || item.bestMove || coordinateMove || item.continuationArr?.[0] || item.continuation?.split?.(/\s+/)?.[0]);
  const rawEval = item.eval ?? item.evaluation;
  const cp = item.centipawns != null && rawEval == null ? Number(item.centipawns) / 100 : rawEval;
  const evalValue = cp === null || cp === undefined || cp === '' ? null : Number(cp);
  const mateValue = item.mate === null || item.mate === undefined || item.mate === '' ? null : Number(item.mate);
  return {
    source,
    move,
    bestMove: move,
    san: item.san || '',
    eval: Number.isFinite(evalValue) ? evalValue : null,
    mate: Number.isFinite(mateValue) ? mateValue : null,
    depth: normalizeEngineDepth(item.depth || depth),
    winChance: Number.isFinite(Number(item.winChance)) ? Number(item.winChance) : winChanceFromEvaluation(evalValue, mateValue),
    continuation: normalizeContinuation(item.continuationArr || item.continuation || item.pv || ''),
    text: item.text || ''
  };
}
function normalizeEngineResponse(data, source, depth) {
  let rawLines = [];
  if (Array.isArray(data)) rawLines = data;
  else if (Array.isArray(data?.lines)) rawLines = data.lines;
  else if (Array.isArray(data?.variations)) rawLines = data.variations;
  else if (Array.isArray(data?.pvs)) rawLines = data.pvs;
  else rawLines = [data];
  const lines = rawLines.map(item => normalizeEngineLine(item, source, depth)).filter(line => line.move || line.eval !== null || line.mate !== null);
  const primary = lines.find(line => line.move) || lines[0] || normalizeEngineLine(data, source, depth);
  if (!primary.move && data?.bestmove) primary.move = primary.bestMove = cleanBestMove(data.bestmove);
  return {
    source,
    bestMove: primary.move || '',
    eval: primary.eval,
    mate: primary.mate,
    depth: normalizeEngineDepth(depth),
    winChance: primary.winChance,
    lines: lines.length ? lines : [primary],
    rawText: data?.text || '',
    calculatedAt: nowISO(),
    terminal: false,
    cached: false
  };
}
async function fetchJSONWithTimeout(url, options = {}, timeout = CLOUD_ENGINE_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function engineCacheKey(fen, depth) {
  return `${ENGINE_CACHE_VERSION}|${normalizeEngineDepth(depth)}|${String(fen).trim()}`;
}
function loadEngineCache() {
  const raw = storageGet(STORAGE.engineCache, null);
  if (!raw || raw.version !== ENGINE_CACHE_VERSION || !raw.entries || typeof raw.entries !== 'object') {
    return { version: ENGINE_CACHE_VERSION, entries: {} };
  }
  const now = Date.now();
  const entries = {};
  for (const [key, entry] of Object.entries(raw.entries)) {
    if (!entry || typeof entry !== 'object') continue;
    const savedAt = Number(entry.savedAt);
    if (!Number.isFinite(savedAt) || now - savedAt > ENGINE_CACHE_TTL) continue;
    if (!entry.data || typeof entry.data !== 'object') continue;
    entries[key] = entry;
  }
  return { version: ENGINE_CACHE_VERSION, entries };
}
function saveEngineCache(cache) {
  const entries = Object.entries(cache.entries || {})
    .sort((a, b) => Number(b[1]?.lastUsed || b[1]?.savedAt || 0) - Number(a[1]?.lastUsed || a[1]?.savedAt || 0))
    .slice(0, ENGINE_CACHE_MAX_ENTRIES);
  storageSet(STORAGE.engineCache, { version: ENGINE_CACHE_VERSION, entries: Object.fromEntries(entries) });
}
function hasEngineScore(analysis) {
  if (!analysis || typeof analysis !== 'object') return false;
  const hasEval = analysis.eval !== null && analysis.eval !== undefined && analysis.eval !== '' && Number.isFinite(Number(analysis.eval));
  const hasMate = analysis.mate !== null && analysis.mate !== undefined && analysis.mate !== '' && Number.isFinite(Number(analysis.mate));
  return hasEval || hasMate;
}
function isValidCachedAnalysis(fen, depth, analysis) {
  if (!analysis || typeof analysis !== 'object' || analysis.source !== 'StockfishOnline') return false;
  if (normalizeEngineDepth(analysis.depth) !== normalizeEngineDepth(depth)) return false;
  if (!hasEngineScore(analysis) || !Array.isArray(analysis.lines)) return false;
  const move = cleanBestMove(analysis.bestMove);
  if (!move) return false;
  try { return !!legalMoveFromUCI(parseFEN(fen), move); }
  catch { return false; }
}
function getCachedAnalysis(fen, depth) {
  const cache = loadEngineCache();
  const key = engineCacheKey(fen, depth);
  const entry = cache.entries[key];
  if (!entry) return null;
  if (!isValidCachedAnalysis(fen, depth, entry.data)) {
    delete cache.entries[key];
    saveEngineCache(cache);
    return null;
  }
  entry.lastUsed = Date.now();
  saveEngineCache(cache);
  return { ...entry.data, cached: true };
}
function putCachedAnalysis(fen, depth, analysis) {
  const cache = loadEngineCache();
  const key = engineCacheKey(fen, depth);
  cache.entries[key] = { savedAt: Date.now(), lastUsed: Date.now(), data: { ...analysis, cached: false } };
  saveEngineCache(cache);
}
function terminalAnalysisForFen(fen, depth) {
  const state = parseFEN(fen);
  const status = gameStatus(state);
  if (!terminalResultForStatus(status)) return null;
  let evaluation = 0;
  let mate = null;
  if (status.type === 'checkmate') {
    evaluation = state.turn === 'w' ? -100 : 100;
    mate = 0;
  }
  const line = {
    source: '规则判定', move: '', bestMove: '', san: '', eval: evaluation, mate,
    depth: normalizeEngineDepth(depth), winChance: evaluation > 0 ? 100 : evaluation < 0 ? 0 : 50,
    continuation: [], text: status.text
  };
  return {
    source: '规则判定', bestMove: '', eval: evaluation, mate, depth: normalizeEngineDepth(depth),
    winChance: line.winChance, lines: [line], rawText: status.text, calculatedAt: nowISO(),
    terminal: true, statusText: status.text, cached: false
  };
}
async function requestCloudAnalysis(fen, { depth = AI_DEFAULT_DEPTH, forceRefresh = false } = {}) {
  const safeDepth = normalizeEngineDepth(depth);
  const normalizedFen = toFEN(parseFEN(fen));
  const terminal = terminalAnalysisForFen(normalizedFen, safeDepth);
  if (terminal) return terminal;
  if (!forceRefresh) {
    const cached = getCachedAnalysis(normalizedFen, safeDepth);
    if (cached) return cached;
  }
  const key = engineCacheKey(normalizedFen, safeDepth);
  if (!forceRefresh && engineInflightRequests.has(key)) return engineInflightRequests.get(key);
  const requestId = ++engineRequestSequence;
  engineLatestRequest.set(key, requestId);
  const promise = (async () => {
    const url = `${CLOUD_ENGINE_ENDPOINT}?fen=${encodeURIComponent(normalizedFen)}&depth=${safeDepth}`;
    const data = await fetchJSONWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!data || data.success === false) throw new Error(data?.data || data?.error || '接口返回失败');
    const analysis = normalizeEngineResponse({ ...data, depth: safeDepth }, 'StockfishOnline', safeDepth);
    if (!analysis.bestMove) throw new Error('接口未返回合法最佳着法。');
    if (!hasEngineScore(analysis)) throw new Error('接口未返回可用的局面评价。');
    const state = parseFEN(normalizedFen);
    if (!legalMoveFromUCI(state, analysis.bestMove)) throw new Error(`接口返回的最佳着法与当前局面不匹配：${analysis.bestMove}`);
    if (engineLatestRequest.get(key) === requestId) putCachedAnalysis(normalizedFen, safeDepth, analysis);
    return analysis;
  })();
  if (!forceRefresh) engineInflightRequests.set(key, promise);
  try { return await promise; }
  finally {
    if (engineInflightRequests.get(key) === promise) engineInflightRequests.delete(key);
    if (engineLatestRequest.get(key) === requestId) engineLatestRequest.delete(key);
  }
}

async function maybeRequestAIMove(force = false) {
  const ai = app.ai;
  const game = ai ? getGameById(ai.gameId) : null;
  if (!ai || !game || game.status !== 'ongoing' || ai.pending) return;
  if (ai.state.turn !== ai.aiColor) return;
  const fen = toFEN(ai.state);
  if (!force && ai.errorFen === fen) return;
  const token = uid();
  ai.requestToken = token;
  ai.pending = true;
  ai.errorFen = '';
  ai.message = 'AI 云端计算中……';
  render();
  try {
    const analysis = await requestCloudAnalysis(fen, { depth: ai.engineDepth, forceRefresh: force });
    if (!app.ai || app.ai.requestToken !== token) return;
    const move = legalMoveFromUCI(ai.state, analysis.bestMove);
    if (!move) throw new Error('接口返回的最佳着法与当前局面不匹配：' + analysis.bestMove);
    const result = moveWithSan(ai.state, move);
    if (!result) throw new Error('AI 着法无法落子：' + analysis.bestMove);
    app.busy = true;
    const slide = await beginBoardMoveSlide(move, 'ai');
    if (!app.ai || app.ai.requestToken !== token) {
      slide?.finish();
      app.busy = false;
      return;
    }
    ai.state = result.state;
    ai.analysis = analysis;
    ai.pending = false;
    ai.message = `AI 走棋：${result.san}`;
    ai.errorFen = '';
    saveAI();
    render();
    slide?.finish();
    app.busy = false;
  } catch (err) {
    app.busy = false;
    if (!app.ai || app.ai.requestToken !== token) return;
    ai.pending = false;
    ai.errorFen = fen;
    ai.message = 'AI API 暂不可用：' + (err?.message || err) + '。可稍后重试。';
    saveAI();
    render();
  }
}

function renderCreateIntro() {
  $app.innerHTML = `
    <section class="layout">
      <div class="card">
        <div class="hero-eyebrow"><span class="badge">谜题制作</span><span class="badge">加密导出</span></div>
        <h2>创建谜题</h2>
        <p class="hero-copy">先摆好初始棋盘，并规定挑战者先手；随后录入双方完整预设解法。保存后可在本地挑战，也可下载为 .txt 加密文件进行分享。</p>
        <div class="form-grid">
          <label class="full">谜题名称
            <input id="createName" maxlength="60" placeholder="例如：一步杀王训练 01" />
          </label>
          <label>挑战者 / 先手
            <select id="createChallenger"><option value="w">白方</option><option value="b">黑方</option></select>
          </label>
          <div class="full switch-line">
            <button data-action="setup-create-empty">从空棋盘摆盘</button>
            <button class="secondary" data-action="setup-create-standard">从标准开局调整</button>
          </div>
        </div>
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h3>创建提示</h3><span class="badge official">版权提醒</span></div>
        <div class="feature-list">
          <div class="feature"><span class="feature-dot"></span><span>初始局面必须有且仅有两个王，且轮到挑战者先走。</span></div>
          <div class="feature"><span class="feature-dot"></span><span>录入的每一步都必须合法；程序会按预设顺序验证挑战者走法。</span></div>
          <div class="feature"><span class="feature-dot"></span><span>下载后的 .txt 加密文件可用于导入练习或发布到官方题库。</span></div>
        </div>
        <div class="copyright-note">谜题编创者版权所有。上传到官方库前请准确填写编创者名称，并确认版权归属与发布授权。</div>
      </aside>
    </section>`;
}

function emptySetupBoard() { return Array(64).fill(null); }

function renderSetup() {
  const setup = app.setup;
  const tempState = {
    board: setup.board,
    turn: setup.turn,
    castling: { ...setup.castling },
    ep: null,
    halfmove: 0,
    fullmove: 1,
    history: [],
    positionCounts: {},
    initialFen: ''
  };
  tempState.initialFen = toFEN(tempState);
  tempState.positionCounts[positionKey(tempState)] = 1;
  const validation = validatePosition(tempState);
  $app.innerHTML = `
    <section class="layout">
      <div class="board-wrap">
        <div class="toolbar"><span class="status-pill ${validation ? 'error' : 'done'}">${validation ? htmlEscape(validation) : '局面有效，可以开始'}</span></div>
        ${boardHTML(tempState, { context: 'setup', invertBlack: false, flip: setup.target === 'creator' && setup.challenger === 'b' })}
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>${setup.target === 'creator' ? '摆放谜题初始棋盘' : '自定义棋局开局'}</h2><span class="badge">编辑器</span></div>
        <div class="palette">
          ${setupPaletteHTML()}
        </div>
        <div class="form-grid">
          <label>先手
            <select id="setupTurn" ${setup.target === 'creator' ? 'disabled' : ''}>
              <option value="w" ${setup.turn === 'w' ? 'selected' : ''}>白方</option>
              <option value="b" ${setup.turn === 'b' ? 'selected' : ''}>黑方</option>
            </select>
          </label>
          <label>编辑操作
            <select id="setupSelected"><option>${setup.selectedLabel}</option></select>
          </label>
        </div>
        <div class="switch-line">
          <label><input type="checkbox" data-castle="K" ${setup.castling.K ? 'checked' : ''}>白方短易位</label>
          <label><input type="checkbox" data-castle="Q" ${setup.castling.Q ? 'checked' : ''}>白方长易位</label>
          <label><input type="checkbox" data-castle="k" ${setup.castling.k ? 'checked' : ''}>黑方短易位</label>
          <label><input type="checkbox" data-castle="q" ${setup.castling.q ? 'checked' : ''}>黑方长易位</label>
        </div>
        <div class="toolbar-left">
          <button class="secondary" data-action="setup-clear">清空棋盘</button>
          <button class="secondary" data-action="setup-standard">载入标准棋盘</button>
          <button class="ok" data-action="finish-setup" ${validation ? 'disabled' : ''}>${setup.target === 'creator' ? '开始录入解法' : '开始对局'}</button>
        </div>
        <div class="empty-state">选中棋子后点击棋盘放置；选择"清除"后点击格子删除棋子。手机端同样可触控操作。</div>
      </aside>
    </section>`;
}

function setupPaletteHTML() {
  const items = [
    ['w','k'], ['w','q'], ['w','r'], ['w','b'], ['w','n'], ['w','p'],
    ['b','k'], ['b','q'], ['b','r'], ['b','b'], ['b','n'], ['b','p'],
    ['x','x']
  ];
  return items.map(([color, type]) => {
    const key = color === 'x' ? 'empty' : color + type;
    const label = color === 'x' ? '清除' : PIECE_UNICODE[color + type.toUpperCase()];
    const active = app.setup.selected === key ? 'active' : '';
    return `<button class="${active}" data-action="setup-pick" data-piece="${key}" title="${label}">${label}</button>`;
  }).join('');
}

function renderCreatorRecord() {
  const c = app.creator;
  const status = gameStatus(c.state);
  const last = c.solution[c.solution.length - 1];
  const saveReady = c.solution.length > 0 && last?.color === c.challenger;
  $app.innerHTML = `
    <section class="layout">
      <div class="board-wrap">
        <div class="toolbar">
          <span class="status-pill ${statusClass(status)}">${htmlEscape(status.text)}</span>
        </div>
        ${boardHTML(c.state, { context: 'creator', invertBlack: false, flip: c.challenger === 'b' })}
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>${htmlEscape(c.name)}</h2><span class="badge">录入答案</span></div>
        <div class="toolbar-left">
          <button class="ghost" data-action="undo-creator" ${c.solution.length ? '' : 'disabled'}>撤销上一步</button>
          <button class="ok" data-action="save-created-level" ${saveReady ? '' : 'disabled'}>保存谜题</button>
        </div>
        <div class="empty-state">请按正确解法依次走双方棋步。保存条件：最后一步是${c.challenger === 'w' ? '白方' : '黑方'}（挑战者）落子。</div>
        ${moveLogHTML(c.state.history)}
      </aside>
    </section>`;
}

function renderLevels() {
  if (app.officialStatus === 'idle') ensureOfficialIndex();
  const local = app.levels || [];
  const official = Array.isArray(app.officialIndex) ? app.officialIndex : [];
  $app.innerHTML = `
    <section class="levels-stack">
      <div class="panel side-panel puzzle-panel official-puzzle-panel">
        <div class="panel-title"><h2>官方谜题</h2><span class="badge official">谜题编创者版权所有</span></div>
        <div class="puzzle-scroll official-scroll">${officialHTML(official)}</div>
        <div class="toolbar-left"><button class="secondary" data-action="refresh-official">刷新官方库</button></div>
        <div class="copyright-note">官方题库逐题标注谜题编创者及版权信息，仅展示以 .txt 结尾的加密谜题文件，且不公开正确解答。</div>
      </div>
      <div class="panel side-panel puzzle-panel">
        <div class="panel-title"><h2>我的谜题</h2><span class="badge">个人题库</span></div>
        <div class="toolbar-left compact-actions">
          <button data-action="open-create">创建新谜题</button>
          <label class="upload-label">
            上传加密谜题
            <input id="importLevelFile" type="file" accept=".txt,text/plain" />
          </label>
        </div>
        <div class="puzzle-scroll local-scroll">
          ${local.length ? `<div class="level-list">${local.map(levelItemHTML).join('')}</div>` : '<div class="empty-state">还没有本地谜题。点击“创建新谜题”即可开始。</div>'}
        </div>
      </div>
    </section>`;
}

function officialHTML(official) {
  if (app.officialStatus === 'loading') return '<div class="empty-state">正在读取官方谜题库……</div>';
  if (!official.length) {
    const reason = app.officialError ? `<br>提示：${htmlEscape(app.officialError)}` : '';
    return `<div class="empty-state">暂无可显示的官方谜题。请确认官方题库已发布 .txt 加密文件；管理员可查看 README 中的官方题库配置说明。${reason}</div>`;
  }
  const passedMap = storageGet(STORAGE.officialPassed, {}) || {};
  const sourceText = official.length ? `<div class="empty-state">已加载 ${official.length} 个官方谜题，点击题目即可开始挑战。</div>` : '';
  return `${sourceText}<div class="level-list">${official.map((item, i) => {
    const entry = normalizeOfficialEntry(item);
    const file = entry.file;
    const title = entry.title || fileNameTitle(file);
    const passed = passedMap[file];
    const meta = passed ? '<span class="passed-mark">✓ 已通过</span> · ' : '';
    const creator = officialCreatorName(entry.creator);
    const desc = entry.description ? `<div class="level-desc">${htmlEscape(entry.description)}</div>` : '';
    return `<article class="level-item official-item">
      <header><div><div class="level-title">${htmlEscape(title)}</div><div class="level-meta">${meta}${htmlEscape(creatorCopyrightText(creator, false))}</div>${desc}</div></header>
      <div class="level-actions"><button data-action="play-official" data-official-index="${i}">进入挑战</button></div>
    </article>`;
  }).join('')}</div>`;
}

function fileNameTitle(file) {
  return String(file || '').split('/').pop().replace(/\.txt$/i, '').replace(/[_-]+/g, ' ') || '官方谜题';
}

function normalizeOfficialFileName(file) {
  const normalized = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const withoutFolder = normalized.startsWith(OFFICIAL_FOLDER + '/') ? normalized.slice(OFFICIAL_FOLDER.length + 1) : normalized;
  if (!withoutFolder || withoutFolder.includes('..') || /^https?:\/\//i.test(withoutFolder)) return '';
  const ext = withoutFolder.slice(withoutFolder.lastIndexOf('.')).toLowerCase();
  if (!OFFICIAL_EXTENSIONS.includes(ext)) return '';
  if (withoutFolder.toLowerCase() === 'manifest.json') return '';
  return withoutFolder;
}

function normalizeOfficialEntry(item) {
  if (typeof item === 'string') {
    return { file: normalizeOfficialFileName(item), creator: DEFAULT_OFFICIAL_CREATOR, copyright: '' };
  }
  const file = normalizeOfficialFileName(item?.file || item?.name || item?.path || '');
  const creator = officialCreatorName(item?.creator || item?.author || item?.compiler);
  return {
    file,
    title: String(item?.title || item?.displayName || '').trim(),
    description: String(item?.description || item?.summary || '').trim(),
    creator,
    copyright: String(item?.copyright || '').trim()
  };
}

function officialFileUrl(file) {
  const safeFile = normalizeOfficialFileName(file);
  return `${OFFICIAL_FOLDER}/${safeFile.split('/').map(encodeURIComponent).join('/')}`;
}

function uniqueOfficialEntries(entries) {
  const seen = new Set();
  return entries.map(normalizeOfficialEntry).filter(entry => {
    if (!entry.file || seen.has(entry.file)) return false;
    seen.add(entry.file);
    return true;
  });
}

function entriesFromManifest(data) {
  const source = Array.isArray(data) ? data : (Array.isArray(data?.files) ? data.files : []);
  return uniqueOfficialEntries(source);
}

async function fetchOfficialConfiguredIndex() {
  const configured = SITE_CONFIG.officialFiles || SITE_CONFIG.officialLevels || [];
  return uniqueOfficialEntries(configured);
}

async function fetchOfficialManifest() {
  const res = await fetch(`${OFFICIAL_FOLDER}/manifest.json`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return entriesFromManifest(data);
}

async function fetchOfficialDirectoryIndex() {
  const res = await fetch(`${OFFICIAL_FOLDER}/`, { cache: 'no-store' });
  if (!res.ok) return [];
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const files = [...doc.querySelectorAll('a[href]')]
    .map(a => decodeURIComponent(a.getAttribute('href') || '').split('?')[0].split('#')[0])
    .map(href => href.split('/').pop())
    .filter(Boolean);
  return uniqueOfficialEntries(files);
}

function inferGitHubRepository() {
  const repo = String(SITE_CONFIG.officialRepository || SITE_CONFIG.githubRepository || '').trim();
  if (repo.includes('/')) return repo;
  const host = location.hostname.toLowerCase();
  if (!host.endsWith('.github.io')) return '';
  const owner = host.replace(/\.github\.io$/, '');
  const firstPath = location.pathname.split('/').filter(Boolean)[0];
  return owner && firstPath ? `${owner}/${firstPath}` : '';
}

async function fetchOfficialGitHubIndex() {
  const repository = inferGitHubRepository();
  if (!repository) return [];
  const branch = encodeURIComponent(String(SITE_CONFIG.officialBranch || 'main'));
  const api = `https://api.github.com/repos/${repository}/contents/${encodeURIComponent(OFFICIAL_FOLDER)}?ref=${branch}`;
  const res = await fetch(api, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return uniqueOfficialEntries(data.filter(item => item.type === 'file').map(item => item.name));
}

function levelItemHTML(level) {
  const passedMark = level.passed ? '<span class="passed-mark">✓ 已通过</span> · ' : '';
  return `<article class="level-item">
    <header>
      <div>
        <div class="level-title">${htmlEscape(level.name)}</div>
        <div class="level-meta">${passedMark}挑战者：${level.challenger === 'w' ? '白方' : '黑方'}；创建：${new Date(level.createdAt || Date.now()).toLocaleString()}</div>
      </div>
    </header>
    <div class="level-actions">
      <button data-action="play-level" data-level-id="${htmlEscape(level.id)}">进入挑战</button>
      <button class="secondary" data-action="show-solution" data-level-id="${htmlEscape(level.id)}">查看正确解法</button>
      <button class="secondary" data-action="export-level" data-level-id="${htmlEscape(level.id)}">下载加密文件</button>
      <button class="danger" data-action="delete-level" data-level-id="${htmlEscape(level.id)}">删除</button>
    </div>
  </article>`;
}

function renderChallenge() {
  const ch = app.challenge;
  if (!ch) { app.view = 'levels'; return render(); }
  const status = gameStatus(ch.state);
  const challenger = ch.level.challenger;
  const complete = ch.passed || ch.index >= ch.level.solution.length;
  const msg = complete ? '已通过' : (ch.message || (ch.pending ? '判定或落子处理中……' : (ch.state.turn === challenger ? '轮到你走棋' : '对方正在回子')));
  const passStamp = complete ? '<div class="pass-stamp-overlay"><span class="pass-stamp">PASS</span></div>' : '';
  $app.innerHTML = `
    <section class="layout">
      <div class="board-wrap">
        <div class="toolbar">
          <span class="status-pill ${complete ? 'done' : (ch.message?.includes('错误') ? 'error' : statusClass(status))}">${htmlEscape(msg)}</span>
        </div>
        ${passStamp}
        ${boardHTML(ch.state, { context: 'challenge', invertBlack: false, flip: challenger === 'b' })}
      </div>
      <aside class="panel side-panel">
        <div class="panel-title"><h2>${htmlEscape(ch.level.name)}</h2><span class="badge">挑战者：${challenger === 'w' ? '白方' : '黑方'}</span></div>
        <div class="toolbar-left">
          <button class="secondary" data-action="restart-challenge">重新开始</button>
          <button class="ghost" data-action="open-levels">返回谜题</button>
          ${ch.official ? '' : '<button class="secondary" data-action="show-current-solution">查看正确解法</button>'}
        </div>
        ${moveLogHTML(ch.state.history)}
        <div class="empty-state">棋子每一着均以匹配移动距离与方向的独立匀速沿直线滑动。挑战者落子后用 0.2 秒执行判定；错误走法将原路滑回，正确走法判定完成 0.3 秒后由对方按预设回子。</div>
        ${ch.official ? `<div class="copyright-note">${htmlEscape(ch.level.copyright || creatorCopyrightText(ch.level.creator || ch.level.author))}</div>` : ''}
      </aside>
    </section>`;
}

function moveLogHTML(history = [], reviews = null) {
  if (!history.length) return '<div class="move-log"><div class="empty-state">暂无落子记录。</div></div>';
  const rows = [];
  history.forEach((entry, index) => {
    let row = rows.find(r => r.no === entry.moveNumber);
    if (!row) { row = { no: entry.moveNumber, w: null, b: null }; rows.push(row); }
    row[entry.color] = { san: entry.san, review: reviews?.[index + 1] || null };
  });
  const cell = item => {
    if (!item) return '<span class="move-san"></span>';
    const grade = item.review ? `<span class="move-grade ${htmlEscape(item.review.tone)}" title="${htmlEscape(item.review.label)}">${htmlEscape(item.review.symbol)}</span>` : '';
    return `<span class="move-san">${htmlEscape(item.san)}${grade}</span>`;
  };
  return `<div class="move-log">${rows.map(r => `<div class="move-row"><span class="move-no">${r.no}.</span>${cell(r.w)}${cell(r.b)}</div>`).join('')}</div>`;
}

function boardHTML(state, options) {
  const selected = app.selected;
  const legal = selected != null ? legalMoves(state, selected) : [];
  const last = state.history?.[state.history.length - 1];
  const rows = [...Array(8).keys()];
  const cols = [...Array(8).keys()];
  if (options.flip) { rows.reverse(); cols.reverse(); }
  const noInteraction = options.noInteraction || false;
  let html = `<div class="chessboard" data-board-context="${options.context}">`;
  for (const r of rows) for (const c of cols) {
    const i = idx(r, c);
    const p = state.board[i];
    const isLight = (r + c) % 2 === 0;
    const isSelected = selected === i;
    const lm = legal.find(m => m.to === i);
    const classes = ['square', isLight ? 'light' : 'dark'];
    if (isSelected) classes.push('selected');
    if (lm) classes.push((lm.capture || lm.enPassant || state.board[i]) ? 'capture' : 'legal');
    if (last && last.from === i) classes.push('last-from');
    if (last && last.to === i) classes.push('last-to');
    const coordRank = c === (options.flip ? 7 : 0) ? `<span class="coord rank">${8 - r}</span>` : '';
    const coordFile = r === (options.flip ? 0 : 7) ? `<span class="coord file">${FILES[c]}</span>` : '';
    const piece = p ? `<span class="piece ${p.color === 'b' ? 'black' : 'white'} ${options.invertBlack && p.color === 'b' ? 'invert' : ''}">${PIECE_UNICODE[pieceKey(p)]}</span>` : '';
    const sqAttr = noInteraction ? '' : `data-square="${i}"`;
    html += `<div class="${classes.join(' ')}" ${sqAttr} aria-label="${squareName(i)}">${coordRank}${coordFile}${piece}</div>`;
  }
  html += '</div>';
  return html;
}

function showToast(text, ms = 2200) {
  $toast.textContent = text;
  $toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => $toast.classList.add('hidden'), ms);
}

function hideModal() {
  $modal.classList.add('hidden');
  $modal.innerHTML = '';
  app.solutionViewer = null;
  clearSolutionAutoTimer();
}
function confirmModal(title, text, okText = '确认') {
  return new Promise(resolve => {
    $modal.innerHTML = `<div class="modal-card"><h3>${htmlEscape(title)}</h3><p>${htmlEscape(text)}</p><div class="modal-actions"><button class="secondary" id="modalCancel">取消</button><button class="danger" id="modalOk">${htmlEscape(okText)}</button></div></div>`;
    $modal.classList.remove('hidden');
    document.getElementById('modalCancel').onclick = () => { hideModal(); resolve(false); };
    document.getElementById('modalOk').onclick = () => { hideModal(); resolve(true); };
  });
}
function promptModal(title, label, initialValue = '', okText = '保存') {
  return new Promise(resolve => {
    $modal.innerHTML = `<div class="modal-card"><h3>${htmlEscape(title)}</h3><label>${htmlEscape(label)}<input id="modalPromptInput" maxlength="80" value="${htmlEscape(initialValue)}" /></label><div class="modal-actions"><button class="secondary" id="modalCancel">取消</button><button id="modalOk">${htmlEscape(okText)}</button></div></div>`;
    $modal.classList.remove('hidden');
    const input = document.getElementById('modalPromptInput');
    input.focus();
    input.select();
    document.getElementById('modalCancel').onclick = () => { hideModal(); resolve(null); };
    document.getElementById('modalOk').onclick = () => {
      const value = input.value.trim();
      hideModal();
      resolve(value || null);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') document.getElementById('modalOk').click();
    };
  });
}

function pickPromotion(color) {
  return new Promise(resolve => {
    $modal.innerHTML = `<div class="modal-card"><h3>选择升变棋子</h3><div class="promo-grid">${PROMOTION_TYPES.map(t => `<button data-promo="${t}">${PIECE_UNICODE[color + t.toUpperCase()]}</button>`).join('')}</div></div>`;
    $modal.classList.remove('hidden');
    $modal.querySelectorAll('[data-promo]').forEach(btn => btn.onclick = () => { const p = btn.dataset.promo; hideModal(); resolve(p); });
  });
}

let solutionAutoTimer = null;
function clearSolutionAutoTimer() {
  if (solutionAutoTimer) { clearInterval(solutionAutoTimer); solutionAutoTimer = null; }
}

function openSolutionViewer(level) {
  clearSolutionAutoTimer();
  const totalSteps = (level.solution || []).length;
  const initialStep = 0;
  app.solutionViewer = { level, stepIndex: initialStep, totalSteps, autoPlaying: false };
  renderSolutionViewerModal();
}

function getSolutionViewerState() {
  const sv = app.solutionViewer;
  if (!sv || !sv.level) return null;
  const steps = sv.level.solution.slice(0, sv.stepIndex);
  return rebuildStateFromHistory(sv.level.initialFen, steps);
}

function renderSolutionViewerModal() {
  const sv = app.solutionViewer;
  if (!sv) return;
  const state = getSolutionViewerState();
  if (!state) return;
  const total = sv.totalSteps;
  const current = sv.stepIndex;
  const currentMove = current > 0 ? sv.level.solution[current - 1] : null;
  const sanText = currentMove ? (currentMove.san || squareName(currentMove.from) + '-' + squareName(currentMove.to)) : '初始局面';
  const colorLabel = currentMove ? (currentMove.color === 'w' ? '白方' : '黑方') : '';
  const isAuto = sv.autoPlaying;
  $modal.innerHTML = `
    <div class="modal-card solution-modal-card">
      <div class="panel-title"><h3>${htmlEscape(sv.level.name)}：正确解法</h3><span class="badge">${current}/${total} 步</span></div>
      <div class="solution-viewer-layout">
        <div class="solution-viewer-board">
          ${boardHTML(state, { context: 'solution-viewer', invertBlack: false, flip: sv.level.challenger === 'b', noInteraction: true })}
        </div>
        <div class="solution-viewer-controls">
          <span class="step-san">${htmlEscape(sanText)} ${colorLabel ? '· ' + colorLabel : ''}</span>
          <span class="step-indicator">第 ${current} / ${total} 步</span>
          <button data-action="solution-goto-start" ${current === 0 ? 'disabled' : ''}>⏮ 初始</button>
          <button data-action="solution-prev" ${current === 0 ? 'disabled' : ''}>◀ 上一步</button>
          <button data-action="solution-next" ${current >= total ? 'disabled' : ''}>下一步 ▶</button>
          <button data-action="solution-goto-end" ${current >= total ? 'disabled' : ''}>最终 ⏭</button>
          <button data-action="solution-auto-toggle" class="${isAuto ? 'danger' : 'ok'}">${isAuto ? '⏹ 停止' : '▶ 自动播放'}</button>
        </div>
      </div>
      <div class="modal-actions">
        <button data-action="close-solution-viewer">关闭</button>
      </div>
    </div>`;
  $modal.classList.remove('hidden');
}

function solutionViewerStep(delta) {
  const sv = app.solutionViewer;
  if (!sv) return;
  const newIndex = Math.max(0, Math.min(sv.totalSteps, sv.stepIndex + delta));
  if (newIndex === sv.stepIndex) {
    if (sv.autoPlaying && newIndex >= sv.totalSteps) {
      sv.autoPlaying = false;
      clearSolutionAutoTimer();
    }
    return;
  }
  sv.stepIndex = newIndex;
  if (sv.autoPlaying && newIndex >= sv.totalSteps) {
    sv.autoPlaying = false;
    clearSolutionAutoTimer();
  }
  renderSolutionViewerModal();
}

function solutionViewerGoto(index) {
  const sv = app.solutionViewer;
  if (!sv) return;
  sv.stepIndex = Math.max(0, Math.min(sv.totalSteps, index));
  if (sv.autoPlaying && sv.stepIndex >= sv.totalSteps) {
    sv.autoPlaying = false;
    clearSolutionAutoTimer();
  }
  renderSolutionViewerModal();
}

function toggleSolutionAutoPlay() {
  const sv = app.solutionViewer;
  if (!sv) return;
  if (sv.autoPlaying) {
    sv.autoPlaying = false;
    clearSolutionAutoTimer();
    renderSolutionViewerModal();
  } else {
    if (sv.stepIndex >= sv.totalSteps) {
      sv.stepIndex = 0;
    }
    sv.autoPlaying = true;
    renderSolutionViewerModal();
    clearSolutionAutoTimer();
    solutionAutoTimer = setInterval(() => {
      if (!app.solutionViewer || !app.solutionViewer.autoPlaying) {
        clearSolutionAutoTimer();
        return;
      }
      if (app.solutionViewer.stepIndex >= app.solutionViewer.totalSteps) {
        app.solutionViewer.autoPlaying = false;
        clearSolutionAutoTimer();
        renderSolutionViewerModal();
        return;
      }
      app.solutionViewer.stepIndex += 1;
      if (app.solutionViewer.stepIndex >= app.solutionViewer.totalSteps) {
        app.solutionViewer.autoPlaying = false;
        clearSolutionAutoTimer();
      }
      renderSolutionViewerModal();
    }, 1400);
  }
}

function startSetup(target, initialBoard, extra = {}) {
  const baseState = initialBoard === 'standard' ? createState() : null;
  const challenger = extra.challenger || 'w';
  app.setup = {
    target,
    name: extra.name || '',
    challenger,
    board: baseState ? cloneBoard(baseState.board) : emptySetupBoard(),
    turn: target === 'creator' ? challenger : (extra.turn || 'w'),
    castling: baseState ? { ...baseState.castling } : { K: false, Q: false, k: false, q: false },
    selected: 'wq',
    selectedLabel: '白后'
  };
  app.selected = null;
  app.view = 'setup';
  render();
}

function labelForSetupPiece(key) {
  if (key === 'empty') return '清除';
  const color = key[0] === 'w' ? '白' : '黑';
  const map = { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' };
  return color + map[key[1]];
}

function finishSetup() {
  const setup = app.setup;
  const temp = {
    board: cloneBoard(setup.board),
    turn: setup.turn,
    castling: { ...setup.castling },
    ep: null,
    halfmove: 0,
    fullmove: 1,
    history: [],
    positionCounts: {},
    initialFen: ''
  };
  temp.initialFen = toFEN(temp);
  temp.positionCounts[positionKey(temp)] = 1;
  const error = validatePosition(temp);
  if (error) return showToast(error);
  const fen = toFEN(temp);
  const state = createState(fen);
  if (setup.target === 'double') {
    startNewDoubleGame(state, '自定义双人对局 ' + new Date().toLocaleString());
  } else {
    app.creator = {
      name: setup.name || '未命名谜题',
      challenger: setup.challenger,
      initialFen: fen,
      state,
      solution: []
    };
    app.view = 'creator-record';
  }
  app.setup = null;
  app.selected = null;
  render();
}

async function handleSquareClick(square) {
  if (app.busy) return;
  if (app.view === 'setup') return handleSetupSquare(square);
  if (app.view === 'double') return handleMoveClick(square, app.play.state, async (move) => {
    const game = getGameById(app.play?.gameId);
    if (game?.status !== 'ongoing') return;
    const result = moveWithSan(app.play.state, move);
    if (!result) return;
    app.play.state = result.state;
    saveDouble();
    app.selected = null;
    render();
  });
  if (app.view === 'ai') return handleAISquare(square);
  if (app.view === 'creator-record') return handleMoveClick(square, app.creator.state, async (move) => {
    const result = moveWithSan(app.creator.state, move);
    if (!result) return;
    app.creator.state = result.state;
    const entry = result.state.history[result.state.history.length - 1];
    app.creator.solution.push({
      color: entry.color,
      moveNumber: entry.moveNumber,
      from: entry.from,
      to: entry.to,
      promotion: entry.promotion || '',
      san: entry.san
    });
    app.selected = null;
    render();
  });
  if (app.view === 'challenge') return handleChallengeSquare(square);
}

function handleSetupSquare(square) {
  if (!app.setup) return;
  const key = app.setup.selected;
  if (key === 'empty') app.setup.board[square] = null;
  else app.setup.board[square] = { color: key[0], type: key[1] };
  render();
}

async function handleMoveClick(square, state, onMove) {
  const piece = state.board[square];
  if (app.selected == null) {
    if (piece && piece.color === state.turn) {
      app.selected = square;
      render();
    }
    return;
  }
  if (piece && piece.color === state.turn && square !== app.selected) {
    app.selected = square;
    render();
    return;
  }
  const legal = legalMoves(state, app.selected).filter(m => m.to === square);
  if (!legal.length) {
    app.selected = null;
    render();
    return;
  }
  let move = legal[0];
  if (legal.length > 1 && legal.some(m => m.promotion)) {
    const promo = await pickPromotion(state.turn);
    move = legal.find(m => m.promotion === promo) || legal[0];
  }
  app.selected = null;
  app.busy = true;
  let slide = null;
  try {
    slide = await beginBoardMoveSlide(move);
    await onMove(move);
  } finally {
    slide?.finish();
    app.busy = false;
  }
}

async function handleChallengeSquare(square) {
  const ch = app.challenge;
  if (!ch || ch.pending || ch.passed || app.busy) return;
  const state = ch.state;
  const challenger = ch.level.challenger;
  if (state.turn !== challenger) return;
  const piece = state.board[square];
  if (app.selected == null) {
    if (piece && piece.color === challenger) { app.selected = square; render(); }
    return;
  }
  if (piece && piece.color === challenger && square !== app.selected) {
    app.selected = square; render(); return;
  }
  const candidates = legalMoves(state, app.selected).filter(m => m.to === square);
  if (!candidates.length) { app.selected = null; render(); return; }
  let move = candidates[0];
  if (candidates.length > 1 && candidates.some(m => m.promotion)) {
    const promo = await pickPromotion(challenger);
    move = candidates.find(m => m.promotion === promo) || candidates[0];
  }
  const expected = ch.level.solution[ch.index];
  app.selected = null;
  ch.pending = true;
  ch.message = '正在执行你的走法……';
  app.busy = true;
  render();
  const slide = await beginBoardMoveSlide(move, 'challenge');
  updateChallengeStatus('正在判定……');
  await sleep(CHALLENGE_JUDGE_DELAY);
  if (!sameMove(move, expected)) {
    await slide?.returnToOrigin();
    ch.pending = false;
    ch.message = '错误：该步与预设最优解不符，已滑回原处。';
    app.busy = false;
    saveActiveChallenge();
    render();
    showToast('走法错误，棋子已滑回原处。');
    return;
  }
  const result = moveWithSan(ch.state, move);
  if (!result) {
    await slide?.returnToOrigin();
    ch.pending = false;
    ch.message = '错误：当前预设走法在此局面中不合法。';
    app.busy = false;
    render();
    return;
  }
  ch.state = result.state;
  ch.index += 1;
  ch.message = '走法正确。';
  saveActiveChallenge();
  render();
  slide?.finish();
  app.busy = false;
  await maybeAdvanceChallengeAI();
}

async function handleAISquare(square) {
  const ai = app.ai;
  const game = ai ? getGameById(ai.gameId) : null;
  if (!ai || !game || game.status !== 'ongoing' || ai.pending) return;
  const state = ai.state;
  if (state.turn !== ai.playerColor) return;
  const piece = state.board[square];
  if (app.selected == null) {
    if (piece && piece.color === ai.playerColor) { app.selected = square; render(); }
    return;
  }
  if (piece && piece.color === ai.playerColor && square !== app.selected) {
    app.selected = square; render(); return;
  }
  const candidates = legalMoves(state, app.selected).filter(m => m.to === square);
  if (!candidates.length) { app.selected = null; render(); return; }
  let move = candidates[0];
  if (candidates.length > 1 && candidates.some(m => m.promotion)) {
    const promo = await pickPromotion(ai.playerColor);
    move = candidates.find(m => m.promotion === promo) || candidates[0];
  }
  const result = moveWithSan(ai.state, move);
  if (!result) return;
  app.selected = null;
  app.busy = true;
  let slide = null;
  try {
    slide = await beginBoardMoveSlide(move, 'ai');
    ai.state = result.state;
    ai.message = `你走棋：${result.san}`;
    ai.errorFen = '';
    ai.undoAvailable = true;
    saveAI();
    render();
  } finally {
    slide?.finish();
    app.busy = false;
  }
  const updatedGame = getGameById(ai.gameId);
  if (updatedGame?.status === 'ongoing') await maybeRequestAIMove();
}

async function maybeAdvanceChallengeAI() {
  const ch = app.challenge;
  if (!ch) return;
  if (ch.index >= ch.level.solution.length) return completeChallenge();
  if (ch.state.turn === ch.level.challenger) {
    ch.pending = false;
    saveActiveChallenge();
    render();
    return;
  }
  ch.pending = true;
  ch.message = '走法正确，等待对方回子……';
  saveActiveChallenge();
  render();
  await sleep(CHALLENGE_REPLY_DELAY);
  if (app.challenge !== ch || ch.passed) return;
  const expected = ch.level.solution[ch.index];
  const result = moveWithSan(ch.state, expected);
  if (!result) {
    ch.pending = false;
    ch.message = '谜题数据错误：预设回子不合法。';
    saveActiveChallenge();
    render();
    return;
  }
  ch.message = '对方正在回子……';
  render();
  app.busy = true;
  const slide = await beginBoardMoveSlide(result.move, 'challenge');
  ch.state = result.state;
  ch.index += 1;
  if (ch.index >= ch.level.solution.length) {
    render();
    slide?.finish();
    app.busy = false;
    return completeChallenge();
  }
  ch.pending = false;
  ch.message = '对方已回子，轮到你。';
  saveActiveChallenge();
  render();
  slide?.finish();
  app.busy = false;
}

function completeChallenge() {
  const ch = app.challenge;
  if (!ch) return;
  ch.pending = false;
  ch.passed = true;
  ch.message = '已通过';
  if (ch.official) {
    const map = storageGet(STORAGE.officialPassed, {}) || {};
    map[ch.level.officialFile || ch.level.id] = true;
    storageSet(STORAGE.officialPassed, map);
  } else {
    const level = app.levels.find(l => l.id === ch.level.id);
    if (level) { level.passed = true; saveLevels(); }
  }
  saveActiveChallenge();
  render();
  showToast('恭喜，谜题已通过！');
}

function startChallenge(level, official = false) {
  const state = createState(level.initialFen);
  app.challenge = { level, state, index: 0, pending: false, message: '', passed: false, official };
  app.activeChallengeKey = activeChallengeKey(app.challenge);
  app.activeChallengeAvailable = official ? null : true;
  app.selected = null;
  app.view = 'challenge';
  saveActiveChallenge();
  render();
  if (state.turn !== level.challenger) maybeAdvanceChallengeAI();
}

function restartChallenge() {
  if (!app.challenge) return;
  const { level, official } = app.challenge;
  startChallenge(level, official);
}

function saveCreatedLevel() {
  const c = app.creator;
  if (!c) return;
  const last = c.solution[c.solution.length - 1];
  if (!last || last.color !== c.challenger) return showToast('最后一步预设棋必须为挑战者落子。');
  const level = {
    id: uid(),
    name: c.name || '未命名谜题',
    author: '本地用户',
    createdAt: new Date().toISOString(),
    initialFen: c.initialFen,
    challenger: c.challenger,
    solution: c.solution,
    passed: false,
    copyright: '版权所有 © 2026 Lin.Zikang。保留所有权利。'
  };
  app.levels.unshift(level);
  saveLevels();
  app.creator = null;
  app.view = 'levels';
  render();
  showToast('谜题已保存到"我的谜题"。');
}

function uint8ToBase64(bytes) {
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function base64ToUint8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function cryptoKey() {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(LEVEL_PASSPHRASE), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('LZK-CHESS-2026-SALT'), iterations: 120000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptLevel(level) {
  const json = JSON.stringify(level);
  if (window.crypto?.subtle) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await cryptoKey();
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
    return JSON.stringify({ magic: LEVEL_MAGIC_AES, version: 1, iv: uint8ToBase64(iv), data: uint8ToBase64(cipher) }, null, 2);
  }
  const bytes = new TextEncoder().encode(json);
  const key = new TextEncoder().encode(LEVEL_PASSPHRASE);
  const out = bytes.map((b, i) => b ^ key[i % key.length]);
  return JSON.stringify({ magic: LEVEL_MAGIC_XOR, version: 1, data: uint8ToBase64(out) }, null, 2);
}
async function decryptLevelText(text) {
  const wrapped = safeJSONParse(text, null);
  if (!wrapped) throw new Error('文件不是有效的加密谜题文本。');
  let json = '';
  if (wrapped.magic === LEVEL_MAGIC_AES) {
    const key = await cryptoKey();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToUint8(wrapped.iv) }, key, base64ToUint8(wrapped.data));
    json = new TextDecoder().decode(plain);
  } else if (wrapped.magic === LEVEL_MAGIC_XOR) {
    const bytes = base64ToUint8(wrapped.data);
    const key = new TextEncoder().encode(LEVEL_PASSPHRASE);
    const out = bytes.map((b, i) => b ^ key[i % key.length]);
    json = new TextDecoder().decode(out);
  } else throw new Error('谜题文件标识不匹配。');
  const level = JSON.parse(json);
  validateLevelObject(level);
  return level;
}
function validateLevelObject(level) {
  if (!level || typeof level !== 'object') throw new Error('谜题数据为空。');
  if (!level.name || !level.initialFen || !['w','b'].includes(level.challenger) || !Array.isArray(level.solution)) throw new Error('谜题字段不完整。');
  const initial = createState(level.initialFen);
  const error = validatePosition(initial);
  if (error) throw new Error('谜题初始局面无效：' + error);
  if (initial.turn !== level.challenger) throw new Error('谜题要求先手必须是挑战者。');
  if (!level.solution.length) throw new Error('谜题至少需要一手预设走法。');
  let state = initial;
  for (const m of level.solution) {
    if (m.color && m.color !== state.turn) throw new Error('谜题预设走法颜色顺序错误。');
    const result = moveWithSan(state, m);
    if (!result) throw new Error('谜题预设走法不合法：' + squareName(m.from) + '-' + squareName(m.to));
    state = result.state;
  }
  if (level.solution[level.solution.length - 1].color !== level.challenger) throw new Error('最后一步预设棋必须为挑战者落子。');
  return true;
}
async function downloadLevel(level) {
  const text = await encryptLevel(level);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = sanitizeFileName(level.name) + '.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importLevelFile(file) {
  if (!isEncryptedTxtName(file?.name)) throw new Error('请上传以 .txt 结尾的加密谜题文件。');
  const text = await file.text();
  const level = await decryptLevelText(text);
  level.id = uid();
  level.importedAt = new Date().toISOString();
  level.passed = false;
  app.levels.unshift(level);
  saveLevels();
  render();
  showToast('加密谜题已导入到“我的谜题”。');
}

async function ensureOfficialIndex(force = false) {
  if (app.officialStatus === 'loading') return;
  if (!force && app.officialStatus !== 'idle' && app.officialChecked) return;
  app.officialChecked = true;
  app.officialStatus = 'loading';
  app.officialError = '';
  app.officialSource = '';
  app.officialIndex = [];
  render();
  const loaders = [
    ['站点配置清单', fetchOfficialConfiguredIndex],
    ['manifest.json 清单', fetchOfficialManifest],
    ['文件夹目录索引', fetchOfficialDirectoryIndex],
    ['GitHub 仓库目录', fetchOfficialGitHubIndex]
  ];
  const errors = [];
  for (const [source, loader] of loaders) {
    try {
      const entries = await loader();
      if (entries.length) {
        app.officialIndex = entries;
        app.officialStatus = 'ready';
        app.officialSource = source;
        render();
        return;
      }
    } catch (err) {
      errors.push(`${source}：${err.message}`);
    }
  }
  app.officialIndex = [];
  app.officialStatus = 'empty';
  app.officialError = errors.length ? errors.join('；') : '未发现 .txt 官方谜题文件。';
  render();
}
async function playOfficial(index) {
  const item = app.officialIndex?.[index];
  if (!item) return;
  const entry = normalizeOfficialEntry(item);
  const file = entry.file;
  if (!file) return showToast('官方谜题文件名无效。', 2600);
  try {
    const res = await fetch(officialFileUrl(file), { cache: 'no-store' });
    if (!res.ok) throw new Error('文件不存在或无法读取。');
    const text = await res.text();
    const level = await decryptLevelText(text);
    const creator = officialCreatorName(entry.creator);
    level.id = 'official_' + file;
    level.name = level.name || entry.title || fileNameTitle(file);
    level.creator = creator;
    level.author = creator;
    level.officialFile = file;
    level.copyright = entry.copyright || creatorCopyrightText(creator);
    startChallenge(level, true);
  } catch (err) {
    showToast('官方谜题加载失败：' + err.message, 3600);
  }
}

function getLevelById(id) { return app.levels.find(l => l.id === id); }

async function onAction(action, el) {
  if (action === 'toggle-island') {
    setIslandOpen(!$dynamicIsland?.classList.contains('is-open'));
    return;
  }
  if (el?.closest('.top-nav') || action === 'home') setIslandOpen(false);
  switch (action) {
    case 'home': app.view = 'home'; app.selected = null; hideModal(); render(); break;
    case 'open-double': ensureActiveDoubleGame(); app.view = 'double'; app.selected = null; hideModal(); render(); break;
    case 'open-ai': app.view = 'ai'; app.selected = null; hideModal(); render(); break;
    case 'new-ai-setup': app.ai = null; app.view = 'ai'; app.selected = null; hideModal(); renderAISetup(); break;
    case 'start-ai-game': {
      const color = document.getElementById('aiPlayerColor')?.value === 'b' ? 'b' : 'w';
      const depth = normalizeEngineDepth(document.getElementById('aiEngineDepth')?.value);
      const name = document.getElementById('aiGameName')?.value.trim() || gameNameInputValue();
      startNewAIGame(color, depth, name);
      break;
    }
    case 'open-games': app.view = 'games'; app.selected = null; hideModal(); render(); break;
    case 'new-standard-double': {
      startNewDoubleGame(createState(), '标准双人对局 ' + new Date().toLocaleString());
      hideModal(); render(); break;
    }
    case 'start-setup-double': startSetup('double', 'standard', { turn: 'w' }); break;
    case 'undo-double': {
      const game = getGameById(app.play?.gameId);
      if (game?.status === 'ongoing' && app.play?.state?.history?.length) { app.play.state = undoState(app.play.state); saveDouble(); app.selected = null; render(); }
      break;
    }
    case 'offer-draw-double': {
      const game = getGameById(app.play?.gameId);
      if (!game || game.status !== 'ongoing') break;
      const ok = await confirmModal('确认和棋？', '双方同意和棋后，本局会保存为已结束，无法继续落子。', '确认和棋');
      if (ok) { setManualGameResult(game, '1/2-1/2', '双方同意和棋'); saveDouble(); render(); showToast('本局已记录为和棋。'); }
      break;
    }
    case 'resign-double': {
      const game = getGameById(app.play?.gameId);
      if (!game || game.status !== 'ongoing') break;
      const resigner = app.play.state.turn;
      const winner = opposite(resigner);
      const ok = await confirmModal('确认认输？', `${colorName(resigner)}认输，${colorName(winner)}获胜。`, '确认认输');
      if (ok) {
        setManualGameResult(game, winner === 'w' ? '1-0' : '0-1', `${colorName(resigner)}认输，${colorName(winner)}获胜`);
        saveDouble(); render(); showToast('本局已记录为认输结束。');
      }
      break;
    }
    case 'undo-ai': {
      const ai = app.ai;
      if (!canUndoAIMove(ai)) break;
      const restored = undoAIStateToPlayerMove(ai.state, ai.playerColor);
      if (!restored) break;
      ai.state = restored;
      ai.undoAvailable = false;
      ai.analysis = null;
      ai.errorFen = '';
      ai.requestToken = '';
      ai.message = '已悔棋：请重新落子。';
      app.selected = null;
      saveAI();
      render();
      showToast('已返回到你上一步落子前，本次不能连续悔棋。');
      break;
    }
    case 'resign-ai': {
      const game = getGameById(app.ai?.gameId);
      if (!game || game.status !== 'ongoing') break;
      const ok = await confirmModal('确认向 AI 认输？', `你执${colorName(app.ai.playerColor)}认输，AI 获胜。`, '确认认输');
      if (ok) {
        setManualGameResult(game, app.ai.aiColor === 'w' ? '1-0' : '0-1', `玩家认输，AI（${colorName(app.ai.aiColor)}）获胜`);
        saveAI(); render(); showToast('AI 对局已结束。');
      }
      break;
    }
    case 'retry-ai-move': await maybeRequestAIMove(true); break;
    case 'continue-game': continueGame(el.dataset.gameId); break;
    case 'open-replay': openReplay(el.dataset.gameId); break;
    case 'rename-game': {
      const game = getGameById(el.dataset.gameId);
      if (!game) break;
      const name = await promptModal('修改棋局名称', '新名称', game.name, '保存');
      if (name) {
        game.name = name.slice(0, 80);
        game.updatedAt = nowISO();
        saveGames();
        if (app.play?.gameId === game.id) saveDouble();
        if (app.ai?.gameId === game.id) saveAI();
        render();
        showToast('棋局名称已更新。');
      }
      break;
    }
    case 'delete-game': {
      const game = getGameById(el.dataset.gameId);
      if (!game) break;
      const ok = await confirmModal('确认删除棋局？', `删除“${game.name}”后不可恢复。`, '删除');
      if (ok) {
        app.games = app.games.filter(g => g.id !== game.id);
        if (app.play?.gameId === game.id) app.play = { gameId: '', state: createState(), viewMode: 'same' };
        if (app.ai?.gameId === game.id) app.ai = null;
        if (app.replay?.gameId === game.id) app.replay = null;
        saveGames();
        render();
        showToast('棋局已删除。');
      }
      break;
    }
    case 'replay-prev': replayStep(-1); break;
    case 'replay-next': replayStep(1); break;
    case 'replay-goto-start': replayGoto(0); break;
    case 'replay-goto-end': {
      const game = getGameById(app.replay?.gameId);
      replayGoto(game ? (getGameState(game).history?.length || 0) : 0);
      break;
    }
    case 'refresh-replay-analysis': {
      if (!app.replay) break;
      app.replay.requestToken = uid();
      app.replay.analysis = null;
      app.replay.moveReview = null;
      app.replay.analysisSignature = '';
      app.replay.pendingSignature = '';
      app.replay.pending = false;
      app.replay.forceRefresh = true;
      app.replay.error = '';
      render();
      break;
    }
    case 'open-create': app.view = 'create'; app.selected = null; hideModal(); render(); break;
    case 'setup-create-empty': {
      const name = document.getElementById('createName')?.value.trim() || '未命名谜题';
      const challenger = document.getElementById('createChallenger')?.value || 'w';
      startSetup('creator', 'empty', { name, challenger }); break;
    }
    case 'setup-create-standard': {
      const name = document.getElementById('createName')?.value.trim() || '未命名谜题';
      const challenger = document.getElementById('createChallenger')?.value || 'w';
      startSetup('creator', 'standard', { name, challenger }); break;
    }
    case 'setup-pick':
      app.setup.selected = el.dataset.piece;
      app.setup.selectedLabel = labelForSetupPiece(app.setup.selected);
      render(); break;
    case 'setup-clear': app.setup.board = emptySetupBoard(); render(); break;
    case 'setup-standard': {
      const s = createState(); app.setup.board = cloneBoard(s.board); app.setup.castling = { ...s.castling }; render(); break;
    }
    case 'finish-setup': finishSetup(); break;
    case 'undo-creator':
      if (app.creator?.solution?.length) {
        app.creator.solution.pop();
        app.creator.state = rebuildStateFromHistory(app.creator.initialFen, app.creator.solution);
        app.selected = null; render();
      }
      break;
    case 'save-created-level': saveCreatedLevel(); break;
    case 'open-levels': app.view = 'levels'; app.selected = null; hideModal(); render(); break;
    case 'play-level': {
      const level = getLevelById(el.dataset.levelId); if (level) startChallenge(level, false); break;
    }
    case 'show-solution': {
      const level = getLevelById(el.dataset.levelId); if (level) openSolutionViewer(level); break;
    }
    case 'show-current-solution':
      if (app.challenge?.official) { showToast('官方谜题不显示正确解法。'); break; }
      if (app.challenge?.level) openSolutionViewer(app.challenge.level);
      break;
    case 'export-level': {
      const level = getLevelById(el.dataset.levelId); if (level) await downloadLevel(level); break;
    }
    case 'delete-level': {
      const level = getLevelById(el.dataset.levelId); if (!level) break;
      const ok = await confirmModal('确认删除谜题？', `删除"${level.name}"后不可恢复。`, '删除');
      if (ok) {
        app.levels = app.levels.filter(l => l.id !== level.id);
        saveLevels();
        if (app.challenge && !app.challenge.official && app.challenge.level.id === level.id) {
          app.challenge = null;
          app.activeChallengeKey = '';
          app.activeChallengeAvailable = null;
          saveActiveChallenge();
        }
        render();
        showToast('谜题已删除。');
      }
      break;
    }
    case 'play-official': await playOfficial(Number(el.dataset.officialIndex)); break;
    case 'refresh-official': await ensureOfficialIndex(true); break;
    case 'restart-challenge': restartChallenge(); break;
    case 'resume-challenge': if (canResumeActiveChallenge()) { app.view = 'challenge'; app.selected = null; hideModal(); render(); } break;
    case 'close-modal': hideModal(); break;
    case 'close-solution-viewer': hideModal(); break;
    case 'solution-prev': solutionViewerStep(-1); break;
    case 'solution-next': solutionViewerStep(1); break;
    case 'solution-goto-start': solutionViewerGoto(0); break;
    case 'solution-goto-end': solutionViewerGoto(app.solutionViewer?.totalSteps || 0); break;
    case 'solution-auto-toggle': toggleSolutionAutoPlay(); break;
  }
}

function onChange(e) {
  if (e.target.id === 'viewModeSelect') {
    app.play.viewMode = e.target.value;
    saveDouble(); render();
  }
  if (e.target.id === 'setupTurn' && app.setup && app.setup.target !== 'creator') {
    app.setup.turn = e.target.value;
    render();
  }
  if (e.target.dataset.castle && app.setup) {
    app.setup.castling[e.target.dataset.castle] = e.target.checked;
    render();
  }
  if (e.target.id === 'importLevelFile' && e.target.files?.[0]) {
    importLevelFile(e.target.files[0]).catch(err => showToast('导入失败：' + err.message, 3200));
    e.target.value = '';
  }
}

document.addEventListener('click', async (e) => {
  if ($dynamicIsland?.classList.contains('is-open') && !e.target.closest('#dynamicIsland')) setIslandOpen(false);
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const action = actionEl.dataset.action;
    if (action) { e.preventDefault(); await onAction(action, actionEl); return; }
  }
  if (app.solutionViewer && $modal.contains(e.target)) return;
  const square = e.target.closest('[data-square]');
  if (square) {
    const boardCtx = e.target.closest('[data-board-context]');
    if (boardCtx && boardCtx.dataset.boardContext === 'solution-viewer') return;
    e.preventDefault();
    await handleSquareClick(Number(square.dataset.square));
  }
});
document.addEventListener('change', onChange);
document.addEventListener('keydown', (e) => {
  const keyboardAction = e.target.closest?.('[role="button"][data-action]');
  if (keyboardAction && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    keyboardAction.click();
    return;
  }
  if (e.key === 'Escape') {
    if ($dynamicIsland?.classList.contains('is-open')) { setIslandOpen(false); return; }
    if (app.solutionViewer && !$modal.classList.contains('hidden')) {
      hideModal(); render(); return;
    }
    hideModal(); app.selected = null; render();
  }
  if (app.solutionViewer && !$modal.classList.contains('hidden')) {
    if (e.key === 'ArrowRight') { e.preventDefault(); solutionViewerStep(1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); solutionViewerStep(-1); return; }
    if (e.key === ' ') { e.preventDefault(); toggleSolutionAutoPlay(); return; }
  }
});

loadData();
render();