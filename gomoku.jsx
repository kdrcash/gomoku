import React, { useState, useEffect, useCallback, useMemo } from "react";
import { RotateCcw, Lightbulb, Settings2, Trophy, Swords, ShieldHalf, Dot, BookOpen } from "lucide-react";

/* ============================================================
   오목 학습 도구 — Gomoku Study
   - AI: Minimax + Alpha-Beta + 패턴 평가 함수
   - 난이도: 탐색 깊이 + 후보 수 + 실수 확률
   - 룰: 렌주룰(흑 금수) / 자유룰 전환
   - 학습: 힌트, 수 설명, 위협 표시, 무르기
   ============================================================ */

const SIZE = 15;
const EMPTY = 0, BLACK = 1, WHITE = 2;

// 패턴 점수 (공격/수비 평가의 기준)
const S = {
  FIVE: 10000000,
  OPEN_FOUR: 1000000,
  FOUR: 100000,
  OPEN_THREE: 50000,
  THREE: 1000,
  OPEN_TWO: 100,
  TWO: 10,
  ONE: 1,
};

const DIFF = {
  easy:   { depth: 2, topN: 8,  randomness: 0.35, label: "입문",  desc: "얕게 읽고 가끔 실수합니다" },
  medium: { depth: 4, topN: 10, randomness: 0.08, label: "중급",  desc: "위협을 잘 막습니다" },
  hard:   { depth: 6, topN: 12, randomness: 0.0,  label: "고급",  desc: "깊이 읽어 빈틈이 적습니다" },
};

const COLORS = {
  bg: "#15171c",
  surface: "#1e2229",
  surface2: "#262b34",
  line: "#3a414d",
  wood: "#d8b074",
  woodDark: "#c79a55",
  grid: "#7a5a2c",
  text: "#e8e6e1",
  textDim: "#9aa0ab",
  gold: "#d4af37",
  attack: "#4a9eff",
  danger: "#e8604c",
  green: "#5fb878",
};

/* ---------------- 보드 유틸 ---------------- */
const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const cloneBoard = (b) => b.map((row) => row.slice());
const opponent = (p) => (p === BLACK ? WHITE : BLACK);

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// (r,c)에 player를 둔 직후 정확히 5목 완성 여부
function checkWinAt(board, r, c, player) {
  for (const [dr, dc] of DIRS) {
    let cnt = 1;
    for (let s = 1; s < 5; s++) {
      const nr = r + dr * s, nc = c + dc * s;
      if (inBounds(nr, nc) && board[nr][nc] === player) cnt++; else break;
    }
    for (let s = 1; s < 5; s++) {
      const nr = r - dr * s, nc = c - dc * s;
      if (inBounds(nr, nc) && board[nr][nc] === player) cnt++; else break;
    }
    if (cnt >= 5) return true;
  }
  return false;
}

/* ---------------- 라인 추출 & 평가 ---------------- */
function getAllLines(board) {
  const lines = [];
  for (let r = 0; r < SIZE; r++) lines.push(board[r].slice());
  for (let c = 0; c < SIZE; c++) {
    const col = [];
    for (let r = 0; r < SIZE; r++) col.push(board[r][c]);
    lines.push(col);
  }
  // 대각선 ↘
  for (let k = -(SIZE - 1); k <= SIZE - 1; k++) {
    const d = [];
    for (let r = 0; r < SIZE; r++) {
      const c = r - k;
      if (inBounds(r, c)) d.push(board[r][c]);
    }
    if (d.length >= 5) lines.push(d);
  }
  // 대각선 ↙
  for (let k = 0; k <= 2 * (SIZE - 1); k++) {
    const d = [];
    for (let r = 0; r < SIZE; r++) {
      const c = k - r;
      if (inBounds(r, c)) d.push(board[r][c]);
    }
    if (d.length >= 5) lines.push(d);
  }
  return lines;
}

function countOcc(str, sub) {
  let n = 0, i = 0;
  while ((i = str.indexOf(sub, i)) !== -1) { n++; i++; }
  return n;
}

function scoreLine(line, player) {
  const n = line.length;
  let s = 0;
  // 5칸 슬라이딩 윈도우: 상대 돌이 없는 구간에서 내 돌 수로 잠재력 평가
  const winScore = [0, S.ONE, S.TWO, S.THREE, S.FOUR, S.FIVE];
  for (let i = 0; i + 5 <= n; i++) {
    let cp = 0, co = 0;
    for (let j = 0; j < 5; j++) {
      const v = line[i + j];
      if (v === player) cp++;
      else if (v !== EMPTY) co++;
    }
    if (co === 0 && cp > 0) s += winScore[cp];
  }
  // 열림 패턴 보너스 (양쪽이 열린 형태는 막기 어려움)
  let str = "";
  for (let i = 0; i < n; i++) str += line[i] === player ? "1" : line[i] === EMPTY ? "0" : "2";
  s += countOcc(str, "011110") * S.OPEN_FOUR;
  const openThree = ["011100", "001110", "010110", "011010"];
  for (const p of openThree) s += countOcc(str, p) * (S.OPEN_THREE - S.THREE);
  return s;
}

function evaluatePlayer(board, player) {
  let s = 0;
  for (const line of getAllLines(board)) s += scoreLine(line, player);
  return s;
}

function evaluateBoard(board, ai) {
  return evaluatePlayer(board, ai) - evaluatePlayer(board, opponent(ai));
}

/* ---------------- 한 점의 위협 분석 (설명/금수용) ---------------- */
// (r,c)에 player를 둔 상태(board 반영 후)에서 그 점이 만드는 패턴
function analyzePoint(board, r, c, player) {
  const res = { five: false, overline: false, openFour: false, fours: 0, openThrees: 0 };
  for (const [dr, dc] of DIRS) {
    let str = "";
    for (let s = -5; s <= 5; s++) {
      const nr = r + dr * s, nc = c + dc * s;
      if (!inBounds(nr, nc)) str += "2";
      else if (board[nr][nc] === player) str += "1";
      else if (board[nr][nc] === EMPTY) str += "0";
      else str += "2";
    }
    if (str.includes("111111")) { res.overline = true; continue; }
    if (str.includes("11111")) { res.five = true; continue; }
    if (str.includes("011110")) { res.openFour = true; res.fours++; continue; }
    const fourPat = ["11110", "01111", "11011", "10111", "11101"];
    if (fourPat.some((p) => str.includes(p))) { res.fours++; continue; }
    const openThreePat = ["01110", "010110", "011010"];
    if (openThreePat.some((p) => str.includes(p))) { res.openThrees++; }
  }
  return res;
}

// 렌주룰 흑 금수: 6목(장목), 4-4, 3-3
function isForbidden(board, r, c) {
  if (board[r][c] !== EMPTY) return false;
  const b = cloneBoard(board);
  b[r][c] = BLACK;
  const a = analyzePoint(b, r, c, BLACK);
  if (a.overline) return true;                  // 장목은 금수 (checkWinAt보다 먼저 확인)
  if (checkWinAt(b, r, c, BLACK)) return false; // 정확히 5목이면 승리 우선
  if (a.fours >= 2) return true;
  if (a.openThrees >= 2) return true;
  return false;
}

/* ---------------- 후보 생성 & 정렬 ---------------- */
function hasNeighbor(board, r, c, dist) {
  for (let dr = -dist; dr <= dist; dr++)
    for (let dc = -dist; dc <= dist; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc) && board[nr][nc] !== EMPTY) return true;
    }
  return false;
}

function quickScore(board, r, c, player) {
  // 정렬용 간이 점수: 그 점에 두었을 때 공격 + 수비 가치
  // board를 임시로 수정 후 복원 (단일 스레드 동기 실행이므로 안전)
  board[r][c] = player;
  const off = analyzePoint(board, r, c, player);
  board[r][c] = opponent(player);
  const def = analyzePoint(board, r, c, opponent(player));
  board[r][c] = EMPTY;
  const val = (a) =>
    (a.five ? 100000 : 0) + (a.openFour ? 50000 : 0) + a.fours * 8000 + a.openThrees * 2000;
  return val(off) + val(def) * 0.9;
}

function getCandidates(board, player, topN) {
  let any = false;
  const cands = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== EMPTY) { any = true; continue; }
    }
  if (!any) return [[7, 7]];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] === EMPTY && hasNeighbor(board, r, c, 2)) {
        cands.push({ r, c, s: quickScore(board, r, c, player) });
      }
    }
  cands.sort((a, b) => b.s - a.s);
  return cands.slice(0, topN).map((m) => [m.r, m.c]);
}

/* ---------------- Zobrist 해시 & 트랜스포지션 테이블 ---------------- */
// 모듈 로드 시 1회 생성 — (r, c, 색) 조합마다 고유 난수
const ZOBRIST = Array.from({ length: SIZE }, () =>
  Array.from({ length: SIZE }, () => [
    Math.floor(Math.random() * 0x80000000), // BLACK
    Math.floor(Math.random() * 0x80000000), // WHITE
  ])
);
const ttable = new Map(); // 탐색 시작 전 clear 후 사용

function computeHash(board) {
  let h = 0;
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (board[r][c] !== EMPTY) h = (h ^ ZOBRIST[r][c][board[r][c] - 1]) >>> 0;
  return h;
}

/* ---------------- Minimax + Alpha-Beta + 트랜스포지션 테이블 ---------------- */
function minimax(board, depth, alpha, beta, maximizing, ai, topN, hash) {
  // 트랜스포지션 테이블 조회
  const ttKey = `${hash}|${depth}|${maximizing ? 1 : 0}`;
  if (ttable.has(ttKey)) return ttable.get(ttKey);

  const cur = maximizing ? ai : opponent(ai);
  const cands = getCandidates(board, cur, topN);

  let result;
  if (cands.length === 0) {
    result = evaluateBoard(board, ai);
  } else if (maximizing) {
    let best = -Infinity;
    for (const [r, c] of cands) {
      board[r][c] = cur;
      const h2 = (hash ^ ZOBRIST[r][c][cur - 1]) >>> 0;
      let val;
      if (checkWinAt(board, r, c, cur)) val = S.FIVE * (depth + 1);
      else if (depth <= 1) val = evaluateBoard(board, ai);
      else val = minimax(board, depth - 1, alpha, beta, false, ai, topN, h2);
      board[r][c] = EMPTY;
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    result = best;
  } else {
    let best = Infinity;
    for (const [r, c] of cands) {
      board[r][c] = cur;
      const h2 = (hash ^ ZOBRIST[r][c][cur - 1]) >>> 0;
      let val;
      if (checkWinAt(board, r, c, cur)) val = -S.FIVE * (depth + 1);
      else if (depth <= 1) val = evaluateBoard(board, ai);
      else val = minimax(board, depth - 1, alpha, beta, true, ai, topN, h2);
      board[r][c] = EMPTY;
      if (val < best) best = val;
      if (best < beta) beta = best;
      if (beta <= alpha) break;
    }
    result = best;
  }

  ttable.set(ttKey, result);
  return result;
}

function getBestMove(srcBoard, player, opts, renju) {
  const board = cloneBoard(srcBoard);
  const { depth, topN, randomness } = opts;
  const opp = opponent(player);

  // 후보 생성 (강제 수 누락 방지를 위해 폭넓게)
  let allCands = getCandidates(board, player, Math.max(topN, 20));
  if (renju && player === BLACK) allCands = allCands.filter(([r, c]) => !isForbidden(srcBoard, r, c));
  if (allCands.length === 0) return null;

  // 1. AI 즉시 승리
  for (const [r, c] of allCands) {
    board[r][c] = player;
    const win = checkWinAt(board, r, c, player);
    board[r][c] = EMPTY;
    if (win) return [r, c];
  }

  // 2. 상대 즉시 승리 강제 차단
  for (const [r, c] of allCands) {
    board[r][c] = opp;
    const win = checkWinAt(board, r, c, opp);
    board[r][c] = EMPTY;
    if (win) return [r, c];
  }

  // 3. Minimax 탐색 (트랜스포지션 테이블 초기화 후 시작)
  const cands = allCands.slice(0, topN);
  ttable.clear();
  const initHash = computeHash(board);

  const results = [];
  for (const [r, c] of cands) {
    board[r][c] = player;
    const h = (initHash ^ ZOBRIST[r][c][player - 1]) >>> 0;
    let val;
    if (depth <= 1) val = evaluateBoard(board, player);
    else val = minimax(board, depth - 1, -Infinity, Infinity, false, player, topN, h);
    board[r][c] = EMPTY;
    results.push({ r, c, val });
  }
  results.sort((a, b) => b.val - a.val);

  // 실수 확률: 가끔 차선을 둠
  let pick = results[0];
  if (randomness > 0 && results.length > 1 && Math.random() < randomness) {
    const pool = results.slice(0, Math.min(3, results.length));
    pick = pool[Math.floor(Math.random() * pool.length)];
  }
  return [pick.r, pick.c];
}

/* ---------------- 수 설명 생성 ---------------- */
function describeMove(beforeBoard, r, c, player) {
  const after = cloneBoard(beforeBoard);
  after[r][c] = player;
  const off = analyzePoint(after, r, c, player);

  const defBoard = cloneBoard(beforeBoard);
  defBoard[r][c] = opponent(player);
  const def = analyzePoint(defBoard, r, c, opponent(player));

  if (off.five) return { kind: "win", text: "5목 완성 — 게임을 마무리하는 수입니다." };
  if (off.fours >= 2 || (off.fours >= 1 && off.openThrees >= 1))
    return { kind: "attack", text: "이중 위협(4-3 등)을 만들었습니다. 한 번에 둘 다 막기 어렵습니다." };
  if (off.openFour) return { kind: "attack", text: "열린 4를 만들었습니다. 막아도 반대쪽으로 5목이 납니다." };
  if (def.five) return { kind: "defend", text: "상대의 5목을 막았습니다. 두지 않으면 졌을 자리입니다." };
  if (def.fours >= 1) return { kind: "defend", text: "상대의 4를 차단했습니다. 다음 수 5목을 막은 것입니다." };
  if (def.openThrees >= 1) return { kind: "defend", text: "상대의 열린 3을 차단했습니다. 열린 4로 자라는 걸 막았습니다." };
  if (off.openThrees >= 1) return { kind: "attack", text: "열린 3으로 공격을 전개합니다. 막지 않으면 열린 4가 됩니다." };
  if (off.fours >= 1) return { kind: "attack", text: "4를 만들어 상대를 압박합니다." };
  return { kind: "build", text: "돌을 연결하며 포석을 다지는 수입니다." };
}

/* ============================================================
   UI 컴포넌트
   ============================================================ */
const PAD = 28;
const CELL = 36;
const BOARD_PX = PAD * 2 + CELL * (SIZE - 1);
const STAR = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
const COL_LABELS = "ABCDEFGHIJKLMNO".split("");

function coordName(r, c) {
  return `${COL_LABELS[c]}${SIZE - r}`;
}

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const fn = () => setWidth(window.innerWidth);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return width;
}

export default function App() {
  const [board, setBoard] = useState(emptyBoard);
  const [history, setHistory] = useState([]); // {r,c,player}
  const [humanColor, setHumanColor] = useState(BLACK);
  const [difficulty, setDifficulty] = useState("medium");
  const [renju, setRenju] = useState(true);
  const [turn, setTurn] = useState(BLACK);
  const [winner, setWinner] = useState(null);
  const [thinking, setThinking] = useState(false);
  const [lastMove, setLastMove] = useState(null);
  const [hint, setHint] = useState(null); // {r,c,text}
  const [message, setMessage] = useState({ kind: "build", text: "흑부터 시작합니다. 교차점을 눌러 착수하세요." });
  const [showSettings, setShowSettings] = useState(false);
  const [forbiddenMode, setForbiddenMode] = useState(true);

  const aiColor = opponent(humanColor);
  const [showGuide, setShowGuide] = useState(false);
  const vw = useWindowWidth();
  const isMobile = vw < 640;

  const resetGame = useCallback(() => {
    setBoard(emptyBoard());
    setHistory([]);
    setTurn(BLACK);
    setWinner(null);
    setLastMove(null);
    setHint(null);
    setThinking(false);
    const msg = humanColor === BLACK
      ? "새 게임을 시작합니다. 흑(당신)이 먼저 둡니다."
      : "새 게임을 시작합니다. 흑(AI)이 먼저 둡니다.";
    setMessage({ kind: "build", text: msg });
  }, [humanColor]);

  // 금수 위치 (흑 차례 & 렌주룰 & 표시 켜짐)
  const forbiddenSet = useMemo(() => {
    const set = new Set();
    if (!renju || !forbiddenMode || winner) return set;
    if (turn !== BLACK) return set;
    if (humanColor !== BLACK) return set;
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (board[r][c] === EMPTY && isForbidden(board, r, c)) set.add(r * SIZE + c);
    return set;
  }, [board, turn, renju, forbiddenMode, winner, humanColor]);

  const placeStone = useCallback(
    (r, c, player) => {
      setBoard((prev) => {
        const nb = cloneBoard(prev);
        nb[r][c] = player;
        return nb;
      });
      setHistory((h) => [...h, { r, c, player }]);
      setLastMove([r, c]);
      setHint(null);
    },
    []
  );

  const handleHumanMove = (r, c) => {
    if (winner || thinking) return;
    if (turn !== humanColor) return;
    if (board[r][c] !== EMPTY) return;
    if (renju && humanColor === BLACK && isForbidden(board, r, c)) {
      setMessage({ kind: "defend", text: `${coordName(r, c)}는 금수입니다 (3-3 / 4-4 / 장목). 다른 곳에 두세요.` });
      return;
    }
    const desc = describeMove(board, r, c, humanColor);
    placeStone(r, c, humanColor);

    const nb = cloneBoard(board);
    nb[r][c] = humanColor;
    if (checkWinAt(nb, r, c, humanColor)) {
      setWinner(humanColor);
      setMessage({ kind: "win", text: "5목 완성! 당신이 이겼습니다." });
      return;
    }
    setMessage(desc);
    setTurn(aiColor);
  };

  // AI 턴
  useEffect(() => {
    if (winner) return;
    if (turn !== aiColor) return;
    setThinking(true);
    const t = setTimeout(() => {
      const move = getBestMove(board, aiColor, DIFF[difficulty], renju);
      if (!move) { setThinking(false); return; }
      const [r, c] = move;
      const desc = describeMove(board, r, c, aiColor);
      placeStone(r, c, aiColor);
      const nb = cloneBoard(board);
      nb[r][c] = aiColor;
      setThinking(false);
      if (checkWinAt(nb, r, c, aiColor)) {
        setWinner(aiColor);
        setMessage({ kind: "win", text: "AI가 5목을 완성했습니다. 다시 도전해보세요." });
        return;
      }
      setMessage({ kind: desc.kind, text: `AI(${coordName(r, c)}): ${desc.text}` });
      setTurn(humanColor);
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [turn, winner]);

  const requestHint = () => {
    if (winner || thinking || turn !== humanColor) return;
    setThinking(true);
    setTimeout(() => {
      const move = getBestMove(board, humanColor, DIFF.hard, renju);
      setThinking(false);
      if (!move) return;
      const [r, c] = move;
      const desc = describeMove(board, r, c, humanColor);
      setHint({ r, c, text: desc.text });
      setMessage({ kind: "build", text: `힌트 — ${coordName(r, c)}: ${desc.text}` });
    }, 60);
  };

  const undo = () => {
    if (thinking) return;
    if (history.length === 0) return;
    // 사람+AI 한 쌍 되돌리기
    let steps = 0;
    const h = [...history];
    while (steps < 2 && h.length > 0) { h.pop(); steps++; }
    const nb = emptyBoard();
    for (const m of h) nb[m.r][m.c] = m.player;
    setBoard(nb);
    setHistory(h);
    setWinner(null);
    setHint(null);
    setLastMove(h.length ? [h[h.length - 1].r, h[h.length - 1].c] : null);
    // 마지막 수를 둔 플레이어의 상대 차례로 복원 (빈 보드면 항상 흑 선공)
    const nextTurn = h.length > 0 ? opponent(h[h.length - 1].player) : BLACK;
    setTurn(nextTurn);
    setMessage({ kind: "build", text: "한 수 물렀습니다." });
  };

  const startWithColor = (color) => {
    setHumanColor(color);
    setBoard(emptyBoard());
    setHistory([]);
    setTurn(BLACK);
    setWinner(null);
    setLastMove(null);
    setHint(null);
    setThinking(false);
    setMessage({
      kind: "build",
      text: color === BLACK ? "당신은 흑입니다. 먼저 두세요." : "당신은 백입니다. AI(흑)가 먼저 둡니다.",
    });
  };

  const msgColor =
    message.kind === "win" ? COLORS.gold :
    message.kind === "attack" ? COLORS.attack :
    message.kind === "defend" ? COLORS.danger : COLORS.textDim;

  const MsgIcon =
    message.kind === "win" ? Trophy :
    message.kind === "attack" ? Swords :
    message.kind === "defend" ? ShieldHalf : Dot;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: isMobile ? "14px 10px 32px" : "24px 16px 48px" }}>
        {/* 헤더 */}
        <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: isMobile ? 20 : 26, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "Georgia, 'Times New Roman', serif" }}>
              오목 연구실 <span style={{ color: COLORS.gold }}>·</span> <span style={{ color: COLORS.textDim, fontSize: 16, fontWeight: 400 }}>Gomoku Study</span>
            </h1>
            <p style={{ margin: "4px 0 0", color: COLORS.textDim, fontSize: 13 }}>
              AI와 두며 위협을 읽는 법을 익히세요 · 힌트와 수 설명 제공
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setShowGuide((v) => !v); setShowSettings(false); }}
              style={btnStyle(showGuide ? COLORS.gold : COLORS.surface2, showGuide ? "#1a1a1a" : COLORS.text)}>
              <BookOpen size={15} /> 학습 가이드
            </button>
            <button onClick={() => { setShowSettings((v) => !v); setShowGuide(false); }}
              style={btnStyle(COLORS.surface2, COLORS.text)}>
              <Settings2 size={15} /> 설정
            </button>
          </div>
        </header>

        {/* 학습 가이드 패널 */}
        {showGuide && <GuidePanel onClose={() => setShowGuide(false)} />}

        {/* 설정 패널 */}
        {showSettings && (
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
              <Field label="난이도">
                <div style={{ display: "flex", gap: 6 }}>
                  {Object.entries(DIFF).map(([k, v]) => (
                    <Chip key={k} active={difficulty === k} onClick={() => setDifficulty(k)}>{v.label}</Chip>
                  ))}
                </div>
                <span style={{ color: COLORS.textDim, fontSize: 12 }}>{DIFF[difficulty].desc}</span>
              </Field>
              <Field label="룰">
                <div style={{ display: "flex", gap: 6 }}>
                  <Chip active={renju} onClick={() => setRenju(true)}>렌주룰 (흑 금수)</Chip>
                  <Chip active={!renju} onClick={() => setRenju(false)}>자유룰</Chip>
                </div>
              </Field>
              <Field label="내 돌">
                <div style={{ display: "flex", gap: 6 }}>
                  <Chip active={humanColor === BLACK} onClick={() => startWithColor(BLACK)}>흑 (선)</Chip>
                  <Chip active={humanColor === WHITE} onClick={() => startWithColor(WHITE)}>백 (후)</Chip>
                </div>
              </Field>
              <Field label="금수 표시">
                <div style={{ display: "flex", gap: 6 }}>
                  <Chip active={forbiddenMode} onClick={() => setForbiddenMode(true)}>켜기</Chip>
                  <Chip active={!forbiddenMode} onClick={() => setForbiddenMode(false)}>끄기</Chip>
                </div>
              </Field>
            </div>
          </div>
        )}

        {/* 본문: 보드 + 패널 */}
        <div style={{ display: "flex", gap: isMobile ? 14 : 22, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* 보드 */}
          <div style={{ flex: isMobile ? "0 0 100%" : "1 1 480px", minWidth: isMobile ? 0 : 320, display: "flex", justifyContent: "center" }}>
            <div style={{ position: "relative", width: "100%", maxWidth: isMobile ? BOARD_PX : undefined }}>
              <svg viewBox={`0 0 ${BOARD_PX} ${BOARD_PX}`} width="100%" style={{ display: "block", borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,0.45)" }}>
                <defs>
                  <radialGradient id="woodG" cx="35%" cy="30%" r="80%">
                    <stop offset="0%" stopColor={COLORS.wood} />
                    <stop offset="100%" stopColor={COLORS.woodDark} />
                  </radialGradient>
                  <radialGradient id="blackG" cx="35%" cy="30%" r="75%">
                    <stop offset="0%" stopColor="#5a5f66" />
                    <stop offset="45%" stopColor="#222529" />
                    <stop offset="100%" stopColor="#0a0c0e" />
                  </radialGradient>
                  <radialGradient id="whiteG" cx="35%" cy="30%" r="75%">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="70%" stopColor="#e9e7e0" />
                    <stop offset="100%" stopColor="#c4c0b6" />
                  </radialGradient>
                </defs>
                <rect x="0" y="0" width={BOARD_PX} height={BOARD_PX} fill="url(#woodG)" />

                {/* 격자선 */}
                {Array.from({ length: SIZE }).map((_, i) => (
                  <g key={i}>
                    <line x1={PAD} y1={PAD + i * CELL} x2={PAD + (SIZE - 1) * CELL} y2={PAD + i * CELL} stroke={COLORS.grid} strokeWidth="1" />
                    <line x1={PAD + i * CELL} y1={PAD} x2={PAD + i * CELL} y2={PAD + (SIZE - 1) * CELL} stroke={COLORS.grid} strokeWidth="1" />
                  </g>
                ))}
                {/* 화점 */}
                {STAR.map(([r, c], i) => (
                  <circle key={i} cx={PAD + c * CELL} cy={PAD + r * CELL} r="3.5" fill={COLORS.grid} />
                ))}

                {/* 좌표 라벨 */}
                {COL_LABELS.map((l, c) => (
                  <text key={"cl" + c} x={PAD + c * CELL} y={14} textAnchor="middle" fontSize="10" fill={COLORS.grid} fontFamily="monospace">{l}</text>
                ))}
                {Array.from({ length: SIZE }).map((_, r) => (
                  <text key={"rl" + r} x={10} y={PAD + r * CELL + 3.5} textAnchor="middle" fontSize="10" fill={COLORS.grid} fontFamily="monospace">{SIZE - r}</text>
                ))}

                {/* 금수 표시 */}
                {[...forbiddenSet].map((key) => {
                  const r = Math.floor(key / SIZE), c = key % SIZE;
                  const x = PAD + c * CELL, y = PAD + r * CELL;
                  return (
                    <g key={"fb" + key}>
                      <line x1={x - 7} y1={y - 7} x2={x + 7} y2={y + 7} stroke={COLORS.danger} strokeWidth="2" strokeLinecap="round" opacity="0.85" />
                      <line x1={x - 7} y1={y + 7} x2={x + 7} y2={y - 7} stroke={COLORS.danger} strokeWidth="2" strokeLinecap="round" opacity="0.85" />
                    </g>
                  );
                })}

                {/* 돌 */}
                {board.map((row, r) =>
                  row.map((v, c) => {
                    if (v === EMPTY) return null;
                    const x = PAD + c * CELL, y = PAD + r * CELL;
                    return (
                      <g key={`s${r}-${c}`}>
                        <circle cx={x} cy={y + 1} r={CELL * 0.42} fill="rgba(0,0,0,0.25)" />
                        <circle cx={x} cy={y} r={CELL * 0.42} fill={v === BLACK ? "url(#blackG)" : "url(#whiteG)"} stroke={v === WHITE ? "#b9b5aa" : "#000"} strokeWidth="0.5" />
                      </g>
                    );
                  })
                )}

                {/* 마지막 수 마커 */}
                {lastMove && (
                  <circle cx={PAD + lastMove[1] * CELL} cy={PAD + lastMove[0] * CELL} r="4"
                    fill="none" stroke={COLORS.gold} strokeWidth="2" />
                )}

                {/* 힌트 마커 */}
                {hint && (
                  <circle cx={PAD + hint.c * CELL} cy={PAD + hint.r * CELL} r={CELL * 0.45}
                    fill="none" stroke={COLORS.green} strokeWidth="2.5" strokeDasharray="4 4" />
                )}

                {/* 클릭 영역 */}
                {board.map((row, r) =>
                  row.map((v, c) => (
                    <circle key={`h${r}-${c}`} cx={PAD + c * CELL} cy={PAD + r * CELL} r={CELL * 0.48}
                      fill="transparent" style={{ cursor: winner || thinking || turn !== humanColor ? "default" : "pointer" }}
                      onClick={() => handleHumanMove(r, c)} />
                  ))
                )}
              </svg>
            </div>
          </div>

          {/* 사이드 패널 */}
          <div style={{ flex: isMobile ? "0 0 100%" : "1 1 280px", minWidth: isMobile ? 0 : 260, display: "flex", flexDirection: "column", gap: 14 }}>
            {/* 상태 */}
            <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 14, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", background: turn === BLACK ? "#16181b" : "#eee", border: "1px solid #888", display: "inline-block" }} />
                <span style={{ fontSize: 14, color: COLORS.textDim }}>
                  {winner ? "게임 종료" : thinking ? "AI가 생각 중…" : turn === humanColor ? "당신 차례" : "AI 차례"}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: COLORS.textDim, fontFamily: "monospace" }}>
                  {DIFF[difficulty].label} · {renju ? "렌주룰" : "자유룰"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 9, alignItems: "flex-start", background: COLORS.surface2, borderRadius: 10, padding: "11px 12px", minHeight: 58 }}>
                <MsgIcon size={17} color={msgColor} style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 13.5, lineHeight: 1.5, color: COLORS.text }}>{message.text}</span>
              </div>
            </div>

            {/* 액션 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={requestHint} disabled={winner || thinking || turn !== humanColor}
                style={btnStyle(COLORS.surface2, COLORS.green, winner || thinking || turn !== humanColor)}>
                <Lightbulb size={16} /> 힌트
              </button>
              <button onClick={undo} disabled={thinking || history.length === 0}
                style={btnStyle(COLORS.surface2, COLORS.text, thinking || history.length === 0)}>
                <RotateCcw size={16} /> 무르기
              </button>
            </div>
            <button onClick={resetGame} style={{ ...btnStyle(COLORS.gold, "#1a1a1a"), justifyContent: "center", fontWeight: 600 }}>
              새 게임
            </button>

            {/* 학습 메모 */}
            <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 14, padding: 16 }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 13, color: COLORS.gold, letterSpacing: "0.04em", textTransform: "uppercase" }}>핵심 패턴</h3>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.5 }}>
                <li><b style={{ color: COLORS.attack }}>열린 3</b> — 양끝이 트인 3. 막지 않으면 열린 4로 자랍니다.</li>
                <li><b style={{ color: COLORS.danger }}>열린 4</b> — 양쪽 다 5목 자리. 한 곳을 막아도 집니다.</li>
                <li><b style={{ color: COLORS.green }}>4-3 / 4-4</b> — 두 위협을 동시에. 이기는 핵심 전술.</li>
                <li><b style={{ color: COLORS.gold }}>금수(흑)</b> — 렌주룰에서 3-3·4-4·장목은 둘 수 없습니다.</li>
              </ul>
            </div>
          </div>
        </div>

        {/* 기보 */}
        {history.length > 0 && (
          <div style={{ marginTop: 18, background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 14, padding: "12px 16px" }}>
            <span style={{ fontSize: 12, color: COLORS.textDim, marginRight: 10 }}>기보</span>
            <span style={{ fontSize: 12.5, fontFamily: "monospace", color: COLORS.textDim }}>
              {history.map((m, i) => (
                <span key={i} style={{ color: m.player === BLACK ? "#cfd3da" : COLORS.textDim }}>
                  {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}{coordName(m.r, m.c)}{m.player === BLACK ? "● " : "○  "}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 작은 UI 헬퍼 ---------------- */
function btnStyle(bg, color, disabled) {
  return {
    display: "flex", alignItems: "center", gap: 7, justifyContent: "center",
    background: bg, color, border: `1px solid ${COLORS.line}`,
    borderRadius: 10, padding: "10px 14px", fontSize: 13.5, fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
    transition: "opacity 0.15s",
  };
}

function Field({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <span style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={{
        background: active ? COLORS.gold : COLORS.surface2,
        color: active ? "#1a1a1a" : COLORS.text,
        border: `1px solid ${active ? COLORS.gold : COLORS.line}`,
        borderRadius: 8, padding: "7px 11px", fontSize: 12.5, fontWeight: active ? 600 : 400,
        cursor: "pointer", whiteSpace: "nowrap",
      }}>
      {children}
    </button>
  );
}

/* ===================== 학습 가이드 ===================== */

function MiniBoard({ grid, cellSize = 22 }) {
  const MC = cellSize, MP = Math.round(MC * 0.52);
  const rows = grid.length, cols = grid[0].length;
  const W = MP * 2 + MC * (cols - 1), H = MP * 2 + MC * (rows - 1);
  return (
    <svg width={W} height={H} style={{ background: COLORS.wood, borderRadius: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.35)", display: "block", flexShrink: 0 }}>
      {grid.map((_, r) => <line key={"h"+r} x1={MP} y1={MP+r*MC} x2={MP+(cols-1)*MC} y2={MP+r*MC} stroke={COLORS.grid} strokeWidth={0.7} />)}
      {Array.from({length:cols}).map((_,c) => <line key={"v"+c} x1={MP+c*MC} y1={MP} x2={MP+c*MC} y2={MP+(rows-1)*MC} stroke={COLORS.grid} strokeWidth={0.7} />)}
      {grid.map((row,r) => row.split("").map((cell,c) => {
        const cx=MP+c*MC, cy=MP+r*MC;
        if (cell==="X") return <g key={r+"-"+c}><circle cx={cx} cy={cy+1} r={MC*0.4} fill="rgba(0,0,0,0.22)"/><circle cx={cx} cy={cy} r={MC*0.4} fill="#1a1c1f"/></g>;
        if (cell==="O") return <g key={r+"-"+c}><circle cx={cx} cy={cy+1} r={MC*0.4} fill="rgba(0,0,0,0.15)"/><circle cx={cx} cy={cy} r={MC*0.4} fill="#edebe4" stroke="#aaa" strokeWidth={0.5}/></g>;
        if (cell==="*") return <circle key={r+"-"+c} cx={cx} cy={cy} r={MC*0.38} fill={COLORS.green} fillOpacity={0.2} stroke={COLORS.green} strokeWidth={1.8} strokeDasharray="3 2"/>;
        if (cell==="!") return <circle key={r+"-"+c} cx={cx} cy={cy} r={MC*0.38} fill={COLORS.danger} fillOpacity={0.2} stroke={COLORS.danger} strokeWidth={1.8}/>;
        return null;
      }))}
    </svg>
  );
}

const STAGE1_DATA = [
  { name:"열린 4 (活四)", badge:"즉시 必死", color:COLORS.danger,
    grid:["......",".XXXX.","......"],
    desc:"양쪽 모두 5목을 완성할 수 있는 빈칸. 상대는 한 곳만 막을 수 있어 어떻게 해도 집니다.",
    tip:"만들어지면 이미 늦습니다. 상대의 열린 3을 보는 즉시 막거나 더 강한 공격으로 선제해야 합니다." },
  { name:"닫힌 4 (眠四)", badge:"즉시 차단", color:COLORS.attack,
    grid:["......","OXXXX.","......"],
    desc:"한쪽이 상대(O)에게 막힌 4. 열린 쪽 한 곳에서만 5목 가능—반드시 막아야 합니다.",
    tip:"닫힌 4를 허용하면 다음 수에 5목입니다. 자신의 4가 없다면 즉시 차단해야 합니다." },
  { name:"점프 4 (跳四)", badge:"즉시 차단", color:COLORS.attack,
    grid:["......",".XX.X.","......"],
    desc:"중간에 빈칸이 있는 4. 빈칸을 채우면 5목 완성—닫힌 4와 위험도가 동일합니다.",
    tip:"점프 4의 빈칸을 막지 않으면 다음 수에 5목이 됩니다." },
  { name:"열린 3 (活三)", badge:"경계", color:COLORS.gold,
    grid:["......",".XXX..","......"],
    desc:"양쪽이 트인 3. 막지 않으면 다음 수에 열린 4(活四)가 되어 필사 상태에 진입합니다.",
    tip:"더 급한 수(4 등)가 없으면 막는 것이 원칙. 공격과 방어 우선순위를 함께 판단하세요." },
  { name:"점프 3 (跳三)", badge:"주의", color:COLORS.textDim,
    grid:["......",".X.XX.","......"],
    desc:"빈칸이 있는 열린 3. 직접 열린 3보다 덜 급하나 두 방향으로 성장하면 빠르게 위험해집니다.",
    tip:"당장 막지 않아도 되는 경우가 많지만, 두 방향 성장 가능 여부를 항상 확인하세요." },
];

const STAGE2_DATA = [
  { name:"열린 4 必死", sub:"대응 불가능",
    grid:["........","........",".XXX*...","........","........"],
    result:"*에 두면 _ X X X X _ → 양쪽 모두 막을 수 없어 필사 확정",
    desc:"열린 4가 생기는 순간 게임 종료. 상대는 한 곳만 막을 수 있어 나머지로 5목. 절대 만들어주지 마세요." },
  { name:"4-3 (사삼) 必死", sub:"흑의 핵심 공격",
    grid:[".......",".......","OXXX*..","....X..","....X..",".......",],
    result:"*에 두면 가로 닫힌 4 + 세로 열린 3 동시 생성 → 둘 다 막을 수 없음",
    desc:"한 수로 4와 3을 동시에 만드는 이중 공격. 렌주룰 흑의 주력 전술 (4-4는 흑 금수이므로 4-3이 핵심)." },
  { name:"4-4 (사사) 必死", sub:"백의 강력 공격",
    grid:["O......",".X.....","..X....","...X...","OXXX*..",".......",],
    result:"*에 두면 가로 닫힌 4 + 대각선 닫힌 4 동시 생성 → 둘 다 막을 수 없음",
    desc:"두 방향에 동시에 닫힌 4를 만드는 공격. 렌주룰에서 흑은 금수지만 백은 자유롭게 사용 가능." },
];

const STAGE4_DATA = [
  { name:"화월 (花月)", note:"가장 많이 연구된 개시. 균형 잡힌 전개로 초보자에게도 추천." },
  { name:"수월 (水月)", note:"공격적 전개로 초반 전투를 유도. 흑이 선호하는 경향." },
  { name:"사월 (斜月)", note:"대각 방향 발전. 변화가 매우 다양해 연구가 많이 축적된 개시." },
  { name:"포월 (浦月)", note:"수비적 포석. 상대의 실수를 유도하며 안정적으로 전개." },
  { name:"협월 (峡月)", note:"좁은 공간에 집중. 단기 전투 특화, 계산력이 중요." },
  { name:"유성 (流星)", note:"빠른 혼전을 유도. 준비 없이 임하면 방향을 잃기 쉬움." },
];

function GuidePanel({ onClose }) {
  const [tab, setTab] = useState(0);
  const TABS = ["기본 패턴", "필사 공격", "VCF 수읽기", "개시 정석"];
  const vw = useWindowWidth();
  const isMobile = vw < 640;

  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.line}`, borderRadius: 14, marginBottom: 18, overflow: "hidden" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px 0" }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>초고수 학습 가이드</span>
          <span style={{ marginLeft: 10, fontSize: 12, color: COLORS.textDim }}>4단계로 배우는 오목 필수 지식</span>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.textDim, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 6px" }}>✕</button>
      </div>

      {/* 탭 바 */}
      <div style={{ display: "flex", padding: "0 18px", borderBottom: `1px solid ${COLORS.line}`, marginTop: 10, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        {TABS.map((t, i) => (
          <button key={i} onClick={() => setTab(i)} style={{
            background: "none", border: "none", cursor: "pointer", padding: isMobile ? "8px 10px" : "8px 14px",
            fontSize: isMobile ? 12 : 13, fontWeight: tab === i ? 600 : 400,
            color: tab === i ? COLORS.gold : COLORS.textDim,
            borderBottom: `2px solid ${tab === i ? COLORS.gold : "transparent"}`,
            marginBottom: -1, transition: "color 0.15s", whiteSpace: "nowrap", flexShrink: 0,
          }}>
            {i + 1}단계 · {t}
          </button>
        ))}
      </div>

      {/* 내용 */}
      <div style={{ padding: isMobile ? 12 : 18, maxHeight: isMobile ? 400 : 520, overflowY: "auto" }}>

        {/* ── 1단계: 기본 패턴 ── */}
        {tab === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: COLORS.textDim }}>
              이 5가지 패턴을 <b style={{ color: COLORS.text }}>눈 감고도 즉시 인식</b>해야 중급 이상으로 올라갈 수 있습니다. X=흑, O=상대(막음)
            </p>
            {STAGE1_DATA.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 14, background: COLORS.surface2, borderRadius: 10, padding: 12, alignItems: "flex-start" }}>
                <MiniBoard grid={p.grid} cellSize={20} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: COLORS.text }}>{p.name}</span>
                    <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4, background: p.color + "28", color: p.color }}>{p.badge}</span>
                  </div>
                  <p style={{ margin: "0 0 5px", fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.55 }}>{p.desc}</p>
                  <p style={{ margin: 0, fontSize: 12, color: COLORS.gold, lineHeight: 1.5 }}>💡 {p.tip}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 2단계: 필사 공격 ── */}
        {tab === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: COLORS.textDim }}>
              <b style={{ color: COLORS.text }}>필사(必死)</b>는 어떻게 막아도 다음 수에 이기는 상태입니다. *(녹색 원)이 두어야 할 위치입니다.
            </p>
            {STAGE2_DATA.map((p, i) => (
              <div key={i} style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: COLORS.text }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: COLORS.textDim }}>— {p.sub}</span>
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <MiniBoard grid={p.grid} cellSize={22} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ background: COLORS.surface, borderRadius: 8, padding: "8px 12px", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: COLORS.green }}>{p.result}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.6 }}>{p.desc}</p>
                  </div>
                </div>
              </div>
            ))}
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600, color: COLORS.text }}>공격 우선순위 요약</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: COLORS.textDim }}>
                {[
                  ["1순위", "내 5목 완성 / 상대 5목 차단", COLORS.danger],
                  ["2순위", "열린 4 만들기 / 상대 열린 4 차단", COLORS.attack],
                  ["3순위", "4-3 / 4-4 공격 (필사 형성)", COLORS.gold],
                  ["4순위", "열린 3 만들기 / 상대 열린 3 차단", COLORS.green],
                ].map(([rank, desc, color]) => (
                  <div key={rank} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ minWidth: 44, fontSize: 11, fontWeight: 700, color, background: color+"22", borderRadius: 4, padding: "2px 6px", textAlign: "center" }}>{rank}</span>
                    <span>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── 3단계: VCF 수읽기 ── */}
        {tab === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 700, color: COLORS.attack }}>VCF — 연속 사(四)로 강제 승리</p>
              <p style={{ margin: "0 0 10px", fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.65 }}>
                닫힌 4(또는 점프 4)를 <b style={{ color: COLORS.text }}>연속으로</b> 만들어 상대가 계속 막기만 하게 만드는 전술입니다.
                상대는 각 수마다 막을 수밖에 없고, 결국 열린 4가 완성되어 필사에 진입합니다.
              </p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <MiniBoard cellSize={20} grid={[
                    ".......",".O.....","..X....","..X....","..X*...",".......",
                  ]} />
                  <span style={{ fontSize: 11, color: COLORS.textDim, textAlign: "center" }}>Step 1: * → 닫힌 4 생성</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <MiniBoard cellSize={20} grid={[
                    ".......",".......",".X.....","..X....","..XX...","..X*...",".......",
                  ]} />
                  <span style={{ fontSize: 11, color: COLORS.textDim, textAlign: "center" }}>Step 2: 막힌 후 또 * → 4</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <MiniBoard cellSize={20} grid={[
                    "........","........",".XXXX*..","........","........",
                  ]} />
                  <span style={{ fontSize: 11, color: COLORS.danger, textAlign: "center" }}>결과: 열린 4 완성 → 필사</span>
                </div>
              </div>
            </div>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 700, color: COLORS.gold }}>VCT — 연속 위협으로 강제 승리</p>
              <p style={{ margin: 0, fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.65 }}>
                VCF보다 넓은 개념입니다. 닫힌 4뿐 아니라 <b style={{ color: COLORS.text }}>열린 3 위협도 섞어</b> 상대를 강제로 유도하고
                결국 VCF 또는 필사 상태로 만듭니다. 수읽기가 훨씬 복잡해지지만 실전에서 더 자주 등장합니다.
              </p>
            </div>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600, color: COLORS.green }}>수읽기 훈련 순서</p>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: COLORS.textDim, lineHeight: 2.1 }}>
                <li>상대 돌을 보고 <b style={{ color: COLORS.text }}>5목까지 최단 경로</b>를 먼저 계산</li>
                <li>닫힌 4 → 닫힌 4 → 열린 4 의 <b style={{ color: COLORS.text }}>3수 VCF</b>부터 반복 연습</li>
                <li>막는 수가 하나뿐인 강제 수순을 읽고, 분기 지점을 정확히 파악</li>
                <li>VCT로 확장 — 열린 3을 연속 만들어 4로 강제 전환하는 수순 탐색</li>
                <li>이 앱의 <b style={{ color: COLORS.gold }}>힌트</b> 버튼으로 AI 추천수가 VCF 시작인지 확인하며 역분석</li>
              </ol>
            </div>
          </div>
        )}

        {/* ── 4단계: 개시 정석 ── */}
        {tab === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700, color: COLORS.gold }}>렌주 공식 개시 구조</p>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                <MiniBoard cellSize={24} grid={[
                  ".......",
                  ".......",
                  ".......",
                  "...X...",
                  ".......",
                  ".......",
                  ".......",
                ]} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.9 }}>
                  <b style={{ color: COLORS.text }}>1수 (흑)</b> — 천원(정중앙) 고정<br />
                  <b style={{ color: COLORS.text }}>2수 (백)</b> — 인접 8칸 중 자유 선택<br />
                  <b style={{ color: COLORS.text }}>3수 (흑)</b> — 5×5 범위 내에서 선택<br /><br />
                  이 조합이 <b style={{ color: COLORS.gold }}>공식 26가지 개시</b>로 분류됩니다.
                  대회에서 흑은 이 중 하나를 사용해야 하며, 백도 해당 개시의 정석을 암기해야 합니다.
                </div>
              </div>
            </div>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: COLORS.text }}>대표 6개 개시 — 암기 우선순위 순</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {STAGE4_DATA.map((o, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: COLORS.surface, borderRadius: 8, padding: "10px 12px" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.textDim, minWidth: 20, paddingTop: 1 }}>{i + 1}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.gold, minWidth: 88, flexShrink: 0 }}>{o.name}</span>
                    <span style={{ fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.5 }}>{o.note}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600, color: COLORS.green }}>개시 정석 학습 방법</p>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: COLORS.textDim, lineHeight: 2.1 }}>
                <li><b style={{ color: COLORS.text }}>화월</b>부터 시작 — 기보와 참고 자료가 가장 많음</li>
                <li>각 개시에서 <b style={{ color: COLORS.text }}>백의 최선 대응</b>을 함께 암기 (흑만 알면 반쪽)</li>
                <li>정석 이탈 시 왜 나쁜지 이해하며 학습 (암기보다 이해 우선)</li>
                <li>실력이 붙으면 전체 26가지를 순서대로 확장하며 암기</li>
                <li>각 개시별 <b style={{ color: COLORS.text }}>유명 대국 기보</b>를 1~2개씩 따라 두며 익힘</li>
              </ol>
            </div>
            <div style={{ background: COLORS.surface2, borderRadius: 10, padding: 14 }}>
              <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600, color: COLORS.textDim }}>⚠ 거짓금수(假禁手) 주의</p>
              <p style={{ margin: 0, fontSize: 12.5, color: COLORS.textDim, lineHeight: 1.65 }}>
                정식 렌주룰에서는 3이 "진짜 3"으로 인정받으려면 그 3을 4로 늘렸을 때 합법적인 수여야 합니다.
                확장하면 금수가 되는 3은 <b style={{ color: COLORS.text }}>거짓 3(假三)</b>으로, 3-3 금수 판정에서 제외됩니다.
                이 앱은 기본 금수만 처리하므로, 대회 수준의 거짓금수 판정은 별도 학습이 필요합니다.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
