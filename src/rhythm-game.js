/**
 * rhythm-game.js
 * Rhythm game engine: note thinning, lane assignment, hit judgment, canvas rendering.
 */

// ---------------------------------------------------------------------------
// extractNotesFromMidy
// ---------------------------------------------------------------------------

export function extractNotesFromMidy(midy) {
  const inverseTempo = 1 / midy.tempo;
  const timeline = midy.timeline;
  const notes = [];
  const programs = new Uint8Array(16);
  const active = new Map();

  for (const event of timeline) {
    const sec = event.startTime * inverseTempo;
    switch (event.type) {
      case "programChange":
        if (event.channel != null) {
          programs[event.channel] = event.programNumber ?? 0;
        }
        break;
      case "noteOn": {
        const key = event.channel * 128 + event.noteNumber;
        if (event.velocity === 0) {
          const note = active.get(key);
          if (note) {
            note.endTime = sec;
            active.delete(key);
          }
          break;
        }
        const note = {
          noteNumber: event.noteNumber,
          startTime: sec,
          endTime: sec,
          channel: event.channel,
          programNumber: programs[event.channel],
        };
        notes.push(note);
        active.set(key, note);
        break;
      }
      case "noteOff": {
        const key = event.channel * 128 + event.noteNumber;
        const note = active.get(key);
        if (note) {
          note.endTime = sec;
          active.delete(key);
        }
        break;
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Judgment enum
// ---------------------------------------------------------------------------

export const Judgment = Object.freeze({
  PERFECT: "perfect",
  GREAT: "great",
  GOOD: "good",
  MISS: "miss",
});

// ---------------------------------------------------------------------------
// Difficulty presets
// ---------------------------------------------------------------------------

/**
 * 難易度プリセット
 *
 * 【方針】各譜面の難易度は「NPS（notes/sec）の帯」で定義し、間引きの強さ
 * （minInterval/globalInterval）は曲ごとに二分探索で逆算する。狙う帯は
 * osu!mania のスター評価がレーンごと・時間方向の密度をベースに算出して
 * いる考え方や、BMS 界隈で密度を「16分換算の相当BPM」に正規化して曲間を
 * 比較する難易度表の考え方を参考に、曲の生データの密度に依存しない基準と
 * した。ただし間引きは「削る」方向にしか働かないため、原曲密度が下限NPSに
 * 満たないスカスカな曲は無理に埋めず、その曲で出せる最大密度（＝間引きなし
 * に近い状態）に留める。これは仕様であり、疎な曲を人工的に混雑させない
 * ための意図的な非対称性。
 *
 * NPS目安（曲ごとに二分探索で実測値をこの帯に収める）:
 *   EASY   ≒ 1.0〜1.5 nps — 音ゲー未経験者（同時押しなし）
 *   BASIC  ≒ 2.0〜3.0 nps — 初心者（最大2）
 *   NORMAL ≒ 3.0〜4.0 nps — カジュアル（最大2）※デフォルト
 *   HARD   ≒ 4.0〜6.0 nps — 経験者（最大3）
 *   EXPERT ≒ 6.0〜9.0 nps — 上級者（最大4）
 *
 * NPS の測定は単純な「総ノート数/曲長」ではなく、windowSec 秒のスライド窓
 * ごとの密度を取り、その percentile 分位点を代表値とする（measureNps 参照）。
 * これにより「静かなイントロが長い曲」で全体平均が薄まって過小評価される
 * ことを避け、実際にプレイする密度帯に近い値で判定できる。
 *
 * globalIntervalRatio は探索する1変数（同一レーン間隔の基準値 iv）に対して
 * 全体最小間隔をどの比率で連動させるかを表す「形」のパラメータ。EASY/BASIC
 * は同時押しをほぼ許さない性格上わずかに広め（>1）、NORMAL 以上は同時押し
 * を活かす分だけ全体間隔をやや詰める（≤1）。密度の絶対量は targetNps 側が
 * 決めるため、ここは曲間で共通の「難易度ごとの手触り」だけを担う。
 *
 * レーン数によるスケール（thinNotes 内で動的適用、探索前と同じ）:
 *   maxSimultaneous = min(base, ceil(laneCount/2))
 *   minInterval     = iv * clamp(4/laneCount, 0.5, 2.0)
 *   → 少ないレーンほど同一レーンへの連続を減らし、
 *     多いレーンほど指の分散を活かした同時押しを増やす
 */
export const DIFFICULTIES = {
  EASY: {
    label: "EASY",
    minDuration: 0.25, // 250ms未満の短音除外（装飾音・経過音）
    targetNps: [1.0, 1.5],
    globalIntervalRatio: 1.15,
    maxSimultaneous: 1, // 同時押しなし
    excludeDrums: true,
  },
  BASIC: {
    label: "BASIC",
    minDuration: 0.15, // 150ms未満除外
    targetNps: [2.0, 3.0],
    globalIntervalRatio: 1.15,
    maxSimultaneous: 2, // 最大2
    excludeDrums: true,
  },
  NORMAL: {
    label: "NORMAL",
    minDuration: 0.10, // 100ms未満除外
    targetNps: [3.0, 4.0],
    globalIntervalRatio: 1.0,
    maxSimultaneous: 2, // 最大2
    excludeDrums: true,
  },
  HARD: {
    label: "HARD",
    minDuration: 0.06, // 60ms未満除外
    targetNps: [4.0, 6.0],
    globalIntervalRatio: 0.9,
    maxSimultaneous: 3, // 最大3
    excludeDrums: true,
  },
  EXPERT: {
    label: "EXPERT",
    minDuration: 0.04, // 40ms未満のみ除外
    targetNps: [6.0, 9.0],
    globalIntervalRatio: 0.8,
    maxSimultaneous: 4, // 最大4
    excludeDrums: false,
  },
};

// ---------------------------------------------------------------------------
// Note density measurement
// ---------------------------------------------------------------------------

/**
 * windowSec 秒のスライド窓（1秒刻み）でノート数を数え、その percentile
 * 分位点を代表 NPS として返す。単純な平均（総数/曲長）だと、長い無音の
 * イントロ・アウトロや静かな間奏で全体が薄まり、サビなど実際にプレイする
 * 部分の密度感を過小評価してしまうため、分位点ベースにしている。
 * times は startTime 昇順であることを前提とする。
 */
function measureNps(times, duration, windowSec = 4, percentile = 0.7) {
  if (times.length === 0 || duration <= 0) return 0;
  if (duration <= windowSec) return times.length / duration;

  const hopSec = 1;
  const counts = [];
  let left = 0, right = 0;
  for (let t = 0; t + windowSec <= duration; t += hopSec) {
    while (left < times.length && times[left] < t) left++;
    if (right < left) right = left;
    while (right < times.length && times[right] < t + windowSec) right++;
    counts.push(right - left);
  }
  if (counts.length === 0) return times.length / duration;

  counts.sort((a, b) => a - b);
  const idx = Math.min(
    counts.length - 1,
    Math.floor(counts.length * percentile),
  );
  return counts[idx] / windowSec;
}

// ---------------------------------------------------------------------------
// Note thinning
// ---------------------------------------------------------------------------

/** Step 2（レーン割当）のみを取り出した関数。密度の二分探索から繰り返し呼ぶ。
 *  ノート種別（tap/hold/release）は endTime-startTime の実測 duration から
 *  HOLD_MIN_DURATION/RELEASE_MIN_DURATION の境界で確定させる。間引きの探索
 *  自体はノート数（発生タイミング）だけを見て行い、種別判定には関与しない。
 *
 *  maxSimultaneous は「同時に押されている（=保持されている）ノート数」の
 *  上限。タップノートだけなら発生タイミングが同時かどうかだけで済むが、
 *  hold/releaseノートは startTime〜endTime の間ずっと押しっぱなしになるため、
 *  Step 1（50msクラスタ内の同時発生数）だけでは足りない。例えば t=0 に
 *  始まる1.5秒のholdノートが1本ある間に、別レーンで t=0.5, t=1.0 と
 *  タップノートが単発で来ても、それぞれは50msクラスタとしては単独なので
 *  Step 1では素通りしてしまうが、プレイヤーの指の本数としては
 *  「holdを押さえたまま追加でもう1本」を要求している。
 *  そこでここでは、新しいノートを割り当てる直前に「その時点で保持中の
 *  （まだ終わっていない）レーン数」を数え、maxSimultaneous以上ならその
 *  ノートを間引く（drop）ことで、実際の同時押し本数を上限内に収める。 */
function assignLanes(
  candidates,
  laneCount,
  minInterval,
  globalInterval,
  maxSimultaneous = Infinity,
) {
  const laneLastStart = new Float64Array(laneCount).fill(-1e9);
  const laneLastEnd = new Float64Array(laneCount).fill(-1e9);
  let globalLast = -1e9;
  const result = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const note = candidates[ci];
    const st = note.startTime;

    if (globalInterval > 0 && st - globalLast < globalInterval) continue;

    // その時点で保持中（endTimeがまだ来ていない）のレーン数を数える。
    // これに新規の1本を足して maxSimultaneous を超えるなら、このノートは
    // 同時押し数の上限維持のために間引く。
    let heldCount = 0;
    for (let l = 0; l < laneCount; l++) {
      if (laneLastEnd[l] > st) heldCount++;
    }
    if (heldCount >= maxSimultaneous) continue;

    const preferred = note.noteNumber % laneCount;
    let bestLane = -1;

    for (let l = 0; l < laneCount; l++) {
      const lane = (preferred + l) % laneCount;
      if (st - laneLastStart[lane] >= minInterval && st >= laneLastEnd[lane]) {
        bestLane = lane;
        break;
      }
    }

    if (bestLane === -1) continue;

    globalLast = st;
    laneLastStart[bestLane] = st;
    laneLastEnd[bestLane] = note.endTime;

    const dur = note.endTime - st;
    const kind = dur < HOLD_MIN_DURATION
      ? NoteKind.TAP
      : dur < RELEASE_MIN_DURATION
      ? NoteKind.HOLD
      : NoteKind.RELEASE;
    result.push({
      noteNumber: note.noteNumber,
      startTime: st,
      endTime: note.endTime,
      channel: note.channel,
      programNumber: note.programNumber,
      lane: bestLane,
      duration: dur,
      kind,
      isHold: kind !== NoteKind.TAP, // HOLD/RELEASE共通: 押しっぱなし系ノート
      isTrace: false, // markTraceNotes で高密度連打を TRACE に昇格
      streamPrev: -1, // TRACE ストリーム内の直前ノート index（連結描画用）
      streamNext: -1, // TRACE ストリーム内の直後ノート index
      hit: false,
      missed: false,
      judgment: null,
      // hold/release専用
      holdActive: false, // head判定済み・tail未判定
      holdHeadJudgment: null, // head判定結果
    });
  }

  return result;
}

/**
 * candidates（クラスタ選別済みの候補ノート列）に対し、targetNps の帯に
 * 実測密度が収まるよう minInterval/globalInterval を二分探索で決定する。
 * iv（同一レーン間隔の基準値）を単一の探索変数とし、globalInterval は
 * cfg.globalIntervalRatio で連動させる。iv が大きいほど間引きが強くなり
 * 密度は単調非増加になるため、二分探索が成立する。
 * 原曲密度が下限 NPS に満たない場合は iv を下限側で打ち切り、無理に
 * ノートを水増ししない（削る方向にしか働かない設計のため）。
 * maxSimultaneous も assignLanes に渡し、探索中の密度測定自体が
 * hold/releaseノートの同時保持数を考慮した実際の間引き結果に基づくようにする。
 */
function computeAdaptiveInterval(
  candidates,
  laneCount,
  cfg,
  laneScale,
  maxSimultaneous,
) {
  const [targetMin, targetMax] = cfg.targetNps ?? [4.0, 5.0];
  const globalRatio = cfg.globalIntervalRatio ?? 1.0;

  const duration = candidates.length
    ? candidates[candidates.length - 1].startTime - candidates[0].startTime
    : 0;
  if (duration <= 0) return { minInterval: 0, globalInterval: 0 };

  let lo = 0.01, hi = 2.0;
  for (let iter = 0; iter < 18; iter++) {
    const iv = (lo + hi) / 2;
    const result = assignLanes(
      candidates,
      laneCount,
      iv * laneScale,
      iv * globalRatio,
      maxSimultaneous,
    );
    const nps = measureNps(result.map((r) => r.startTime), duration);

    if (nps > targetMax) {
      lo = iv; // 密度が高すぎる → もっと間引く（iv を大きく）
    } else if (nps < targetMin) {
      hi = iv; // 密度が低すぎる → 間引きを弱める（iv を小さく）
    } else {
      return { minInterval: iv * laneScale, globalInterval: iv * globalRatio };
    }
  }
  // 帯に収まらず打ち切り：lo（帯を超えない直近の iv）を採用。
  // 原曲が疎な曲では lo ≈ 探索下限に張り付き、間引きはほぼ働かない。
  return { minInterval: lo * laneScale, globalInterval: lo * globalRatio };
}

export function thinNotes(
  notes,
  laneCount = 4,
  difficulty = DIFFICULTIES.NORMAL,
  extraOpts = {},
) {
  const cfg = { ...difficulty, ...extraOpts };
  const {
    minDuration = 0.08,
    excludeDrums = true,
  } = cfg;

  // レーン数によるスケール適用
  // maxSimultaneous: レーンが少ないほど減らす（上限=ceil(laneCount/2)）
  // minInterval: レーンが少ないほど広げる（同一レーン連打防止）
  //   スケール係数 = clamp(4/laneCount, 0.5, 2.0)
  const laneScale = Math.min(2.0, Math.max(0.5, 4 / laneCount));
  const maxSimultaneous = Math.max(
    1,
    Math.min(cfg.maxSimultaneous ?? 2, Math.ceil(laneCount / 2)),
  );

  if (!notes || notes.length === 0) return [];

  // Step 0: pre-filter
  const prefiltered = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (excludeDrums && n.channel === 9) continue;
    if (n.endTime - n.startTime < minDuration) continue;
    prefiltered.push(n);
  }

  // Step 1: cluster within 50ms, keep top maxSimultaneous by importance
  const CLUSTER_WIN = 0.05;
  const candidates = [];
  let i = 0;
  while (i < prefiltered.length) {
    const t = prefiltered[i].startTime;
    let j = i;
    while (
      j < prefiltered.length && prefiltered[j].startTime < t + CLUSTER_WIN
    ) j++;
    if (j - i === 1) {
      // 単音クラスタ：sort 不要
      candidates.push(prefiltered[i]);
    } else {
      const cluster = prefiltered.slice(i, j);
      cluster.sort((a, b) => {
        const durDiff = (b.endTime - b.startTime) - (a.endTime - a.startTime);
        if (Math.abs(durDiff) > 0.05) return durDiff > 0 ? 1 : -1;
        return Math.abs(a.noteNumber - 60) - Math.abs(b.noteNumber - 60);
      });
      const keep = Math.min(maxSimultaneous, cluster.length);
      for (let k = 0; k < keep; k++) candidates.push(cluster[k]);
    }
    i = j;
  }

  // Step 2: lane assignment
  // extraOpts で minInterval/globalInterval が明示指定された場合はそれを
  // そのまま使う（従来通りの手動指定・デバッグ用の抜け道として維持）。
  // 指定が無ければ targetNps の帯に収まるよう曲ごとに自動計算する。
  let minInterval, globalInterval;
  if (extraOpts.minInterval != null && extraOpts.globalInterval != null) {
    minInterval = extraOpts.minInterval * laneScale;
    globalInterval = extraOpts.globalInterval;
  } else {
    ({ minInterval, globalInterval } = computeAdaptiveInterval(
      candidates,
      laneCount,
      cfg,
      laneScale,
      maxSimultaneous,
    ));
  }

  const result = assignLanes(
    candidates,
    laneCount,
    minInterval,
    globalInterval,
    maxSimultaneous,
  );

  // Step 3: 同一レーンの高密度 TAP 連打を TRACE ストリームに変換
  // （HOLD/RELEASE はそのまま。間引き後の実プレイ密度で判定する）
  markTraceNotes(result, cfg.traceMaxGap ?? TRACE_MAX_GAP);

  if (typeof cfg.onDensityMeasured === "function") {
    const duration = candidates.length
      ? candidates[candidates.length - 1].startTime - candidates[0].startTime
      : 0;
    cfg.onDensityMeasured(
      measureNps(result.map((r) => r.startTime), duration),
      cfg.targetNps,
    );
  }

  return result;
}

/**
 * 同一レーンで TRACE_MAX_GAP 以下の間隔で連続する TAP を TRACE に変換する。
 * 2本以上の連なりだけを対象にし、孤立した TAP はそのまま残す。
 * 各 TRACE に streamPrev / streamNext インデックスを付け、描画時に
 * ノート同士を「くっついた帯」として連結できるようにする。
 */
function markTraceNotes(notes, maxGap = TRACE_MAX_GAP) {
  if (!notes || notes.length < TRACE_MIN_COUNT) return;

  // レーンごとに開始時刻順のインデックス列を作る（notes 自体は全体 startTime 昇順）
  const byLane = new Map();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.kind !== NoteKind.TAP) continue;
    let arr = byLane.get(n.lane);
    if (!arr) {
      arr = [];
      byLane.set(n.lane, arr);
    }
    arr.push(i);
  }

  for (const indices of byLane.values()) {
    if (indices.length < TRACE_MIN_COUNT) continue;

    // 連続区間を走査してギャップが maxGap 以下のランを TRACE 化
    let runStart = 0;
    for (let k = 1; k <= indices.length; k++) {
      const unbroken = k < indices.length &&
        (notes[indices[k]].startTime - notes[indices[k - 1]].startTime) <=
          maxGap;
      if (unbroken) continue;

      const runLen = k - runStart;
      if (runLen >= TRACE_MIN_COUNT) {
        for (let r = runStart; r < k; r++) {
          const idx = indices[r];
          const note = notes[idx];
          note.kind = NoteKind.TRACE;
          note.isHold = false;
          note.isTrace = true;
          // ストリーム内の前後リンク（描画で帯を繋ぐ用）
          note.streamPrev = r > runStart ? indices[r - 1] : -1;
          note.streamNext = r < k - 1 ? indices[r + 1] : -1;
        }
      }
      runStart = k;
    }
  }
}

// ---------------------------------------------------------------------------
// Judgment windows
// ---------------------------------------------------------------------------

export const DEFAULT_JUDGMENT_WINDOWS = {
  perfect: 0.040,
  great: 0.080,
  good: 0.150,
};

/**
 * ノート種別
 *   TAP     : duration < HOLD_MIN_DURATION              → 単押し
 *   HOLD    : HOLD_MIN_DURATION <= duration < RELEASE_MIN_DURATION → 押しっぱなし
 *             （終端まで押し続けていればよく、離すタイミングの精度は問わない）
 *   RELEASE : duration >= RELEASE_MIN_DURATION           → 従来のホールド実装相当
 *             （終端ちょうどで離す操作そのものを判定する）
 *   TRACE   : 同一レーンで TRACE_MAX_GAP 以下の間隔で連なる高密度ストリーム
 *             （プロセカのトレース相当）。判定ライン通過時にレーンが押されていれば
 *             PERFECT、押されていなければ MISS。中間判定なし。押下タイミングの
 *             精密さは問わず「触れている／押し続けている」だけでコンボを繋げる。
 *             見た目は細いノート＋連続するトレース同士を連結した帯で描画する。
 */
export const NoteKind = Object.freeze({
  TAP: "tap",
  HOLD: "hold",
  RELEASE: "release",
  TRACE: "trace",
});

/** ノート種別の境界 */
export const HOLD_MIN_DURATION = 0.30; // これ以上の duration → HOLD/RELEASE（0.30s未満はTAP）
export const RELEASE_MIN_DURATION = 1.00; // これ以上の duration → RELEASE（未満はHOLD）
/** 同一レーンでこの間隔（秒）以下で連続する TAP 群を TRACE ストリームに変換する。
 *  0.2s ≒ BPM150 の 16 分音符間隔。これより密な連打は個別タップより「押しっぱなしで
 *  撫でる」ほうが自然な操作になるため。 */
export const TRACE_MAX_GAP = 0.20;
/** トレースをストリームとして成立させる最小本数（2本以上で連結表示・TRACE化）。 */
export const TRACE_MIN_COUNT = 2;
// タップノートは常に不透明、ホールド/リリースノートは常にこの固定値で半透明にする。
// これにより、隣接する tap/hold/release ノート同士でもどちらか一目で区別できる。
// （不透明度の可変設定は廃止。将来ノート形状を絵文字などにする場合にも
//   不透明前提のほうが扱いやすいため。）
export const HOLD_OPACITY = 0.5;
/** トレース本体の不透明度（細い帯＋連結線で「なぞる」感を出すため半透明寄り）。 */
export const TRACE_OPACITY = 0.72;
/** トレースノートの見た目の高さ（タップ noteHeight に対する比率）。細くして区別する。 */
export const TRACE_HEIGHT_RATIO = 0.42;
// HOLDノートは「終端まで押していればよい」だけなので、tail判定の基準時刻を
// 実際の endTime より少し早めた地点にする。これにより早めに指を離しても
// noteOff側のPERFECT/GREATが取りやすくなる（RELEASEノートは従来通り endTime 基準）。
export const HOLD_TAIL_LEAD = 0.15; // 秒（HOLDノートのtail判定を早める量）
// head/tailキャップの高さ（タップノートのnoteHeightに対する比率）。
// 1.0だとタップノートと同じ大きさになり紛らわしいので、控えめに小さくする。
export const CAP_HEIGHT_RATIO = 0.5;
// head/tailの不透明キャップと、半透明の本体との境目をなじませるグラデーション幅（px、論理px基準）。
// 0にするとキャップの輪郭がくっきりした段差になる。
export const CAP_BLEND_PX = 40;

/** "#rrggbb" / "rgb(...)" をamt(0〜1)だけグレーに近づけたrgb文字列に変換（簡易版） */
function desaturateColor(hex, amt) {
  let r, g, b;
  if (hex.startsWith("#")) {
    const n = parseInt(hex.slice(1), 16);
    r = (n >> 16) & 0xff;
    g = (n >> 8) & 0xff;
    b = n & 0xff;
  } else {
    [r, g, b] = hex.match(/\d+/g).map(Number);
  }
  const gray = (r + g + b) / 3;
  r = Math.round(r + (gray - r) * amt);
  g = Math.round(g + (gray - g) * amt);
  b = Math.round(b + (gray - b) * amt);
  return `rgb(${r},${g},${b})`;
}

/** 塗りつぶしのみのテキスト描画（fillColor で塗る）。 */
function drawText(ctx, text, x, y, fillColor) {
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
}
/**
 * "#rrggbb" / "rgb(r,g,b)" 形式の色に任意のアルファを付けて "rgba(r,g,b,a)" にする。
 * レーン区切り線・判定ライン・キーラベル・HUD文字など「白決め打ち」だった
 * UIパーツはここを経由させ、o.uiColor（呼び出し側が currentColor 相当として渡す
 * テーマの文字色）を土台にすることで、ダーク/ライト両テーマで見えるようにする。
 */
function withAlpha(color, alpha) {
  let r, g, b;
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 0xff;
    g = (n >> 8) & 0xff;
    b = n & 0xff;
  } else {
    [r, g, b] = color.match(/\d+/g).map(Number);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// RhythmGame
// ---------------------------------------------------------------------------

const DEFAULT_LANE_COLORS = [
  "#ff6666",
  "#66ccff",
  "#ffcc66",
  "#66ff99",
  "#cc66ff",
  "#ff9966",
  "#66ffcc",
  "#ff66cc",
];

// 判定FX の定義テーブル（毎フレームのswitch/文字列生成を回避）
// size は論理px（dpr=1基準）。描画時に o.dpr を掛ける。
const FX_TABLE = {
  [Judgment.PERFECT]: { text: "PERFECT", color: "#ffe066", size: 20 },
  [Judgment.GREAT]: { text: "GREAT", color: "#aaffaa", size: 19 },
  [Judgment.GOOD]: { text: "GOOD", color: "#66ccff", size: 17 },
  [Judgment.MISS]: { text: "MISS", color: "#ff6666", size: 16 },
};

export class RhythmGame {
  onJudgment = null;
  onEnded = null;

  #endedFired = false;
  #canvas;
  #ctx;
  #pCanvas;
  #pCtx;
  #uiCanvas;
  #uiCtx;
  #opts;
  #notes = [];
  #noteIndex = 0;
  // 描画開始カーソル（resolvedDrawStart の線形スキャンを O(1) に）
  #drawCursor = 0;
  #lanePressed = [];
  #laneLastEmpty = [];
  #laneHold = []; // レーンごとに保持中のホールドノートindex（-1=なし）
  #holdTrailTimer = []; // レーンごとのホールド中トレイル粒子スポーン間隔タイマー
  #judgmentFx = [];
  #fxHead = 0; // ring-buffer head (未使用スロット削減)
  #particles = [];
  #score = 0;
  #combo = 0;
  #maxCombo = 0;
  #judgedNotes = 0;
  #perfectCount = 0;
  #greatCount = 0;
  #goodCount = 0;
  #missCount = 0;
  #getTime = null;
  #animId = null;
  #lastFrameMs = 0;
  #lastTickTime = 0;
  #boundLoop = this.#loop.bind(this);

  // キャッシュ（フレームをまたいで再利用）
  #cachedW = 0;
  #cachedH = 0;
  #cachedHitY = 0;
  #cachedLaneW = 0;
  #cachedBtnFont = "";
  #cachedComboFont = "";
  #uiDirty = true; // UIレイヤーの再描画フラグ

  constructor(canvas, options = {}) {
    if (canvas && typeof canvas === "object" && "note" in canvas) {
      this.#canvas = canvas.note;
      this.#pCanvas = canvas.particle;
      this.#uiCanvas = canvas.ui;
    } else {
      this.#canvas = this.#pCanvas = this.#uiCanvas = canvas;
    }
    this.#ctx = this.#canvas.getContext("2d");
    this.#pCtx = this.#pCanvas.getContext("2d");
    this.#uiCtx = this.#uiCanvas.getContext("2d");

    const laneCount = options.laneCount ?? 4;
    // dpr: canvas バッファは CSS サイズ × dpr。論理px（dpr=1基準）の定数は
    // 描画時に dpr を掛けて、高DPIでも見た目サイズが PC と同じになるようにする。
    const dpr = Number(options.dpr) > 0 ? Number(options.dpr) : 1;
    this.#opts = {
      laneCount,
      dpr,
      glow: options.glow ?? false,
      // レーン（判定ボタン部分）の背景・境界線の不透明度スケール（1.0=デフォルトの強さ）。
      // ノート自体は常に不透明固定なので、これはレーン側だけの見え方を調整する
      // 独立した設定。
      laneOpacity: options.laneOpacity ?? 1.0,
      // scrollSpeed / noteHeight は論理px（dpr=1基準）。描画・落下計算で dpr を掛ける。
      scrollSpeed: options.scrollSpeed ?? 500,
      noteHeight: options.noteHeight ?? 36,
      buttonZoneHeight: options.buttonZoneHeight ?? 80,
      laneColors: options.laneColors ?? DEFAULT_LANE_COLORS.slice(0, laneCount),
      keys: options.keys ?? ["d", "f", "j", "k"],
      // レーン区切り線・判定ライン・キーラベル・HUD文字などの土台色。
      // CSS の currentColor 相当。呼び出し側（メインスレッド）でテーマの文字色
      // （例: getComputedStyle(document.body).color）を渡してもらう想定で、
      // 未指定時は従来どおり白（ダーク背景前提）にフォールバックする。
      uiColor: options.uiColor ?? "#ffffff",
      // 判定ライン専用の色。"" なら uiColor（テーマ文字色）にフォールバックする。
      judgeLineColor: options.judgeLineColor ?? "",
      // レーンキーラベル（ASDF等）の待機時の文字色。"" なら uiColor にフォールバックする。
      // 押下中はレーン色で表示するため、accentColor は待機時のみ影響する。
      accentColor: options.accentColor ?? "",
      // レーン区切り線（境界線・疑似床グラデーション）専用の色。
      // "" なら uiColor にフォールバックする。背景画像によっては uiColor だけでは
      // コントラストが足りず線が見えなくなることがあるため、独立して指定できるようにしている。
      laneLineColor: options.laneLineColor ?? "",
      windows: options.judgmentWindows ?? DEFAULT_JUDGMENT_WINDOWS,
      judgeOffset: options.judgeOffset ?? 0, // 秒 (正=遅く, 負=早く)
      startDelay: options.startDelay ?? 0, // 秒 (midy.startDelayと合わせる)
      totalNotes: 0,
      difficulty: options.difficulty ?? DIFFICULTIES.NORMAL,
      thinExtra: options.thinExtra ?? {},
      perspective: options.perspective ?? 0.78, // 0=平面, 1=強い遠近感
      // ホスト側（canvas の上に浮く透過ナビ等）が右上 HUD と重ならないように
      // 避けてほしい量。canvas 座標系（dpr込み）でのpx。0=従来通り詰める。
      topInset: options.topInset ?? 0,
    };
    this.#lanePressed = new Array(laneCount).fill(false);
    this.#laneLastEmpty = new Float64Array(laneCount).fill(-1e9);
    this.#laneHold = new Int32Array(laneCount).fill(-1);
    this.#holdTrailTimer = new Float64Array(laneCount).fill(0);
  }

  // ---- Public API ---------------------------------------------------------

  setNotesRaw(laneNotes) {
    this.#notes = laneNotes;
    this.#noteIndex = 0;
    this.#drawCursor = 0;
    this.#opts.totalNotes = laneNotes.length;
    return laneNotes.length;
  }

  resetState() {
    this.#resetState();
  }

  setNotes(notes) {
    this.#notes = thinNotes(
      notes.slice().sort((a, b) => a.startTime - b.startTime),
      this.#opts.laneCount,
      this.#opts.difficulty,
      this.#opts.thinExtra,
    );
    this.#noteIndex = 0;
    this.#drawCursor = 0;
    this.#opts.totalNotes = this.#notes.length;
    return this.#notes.length;
  }

  start(getTime) {
    this.#resetState();
    this.#getTime = getTime ??
      (() => (performance.now() - this.#lastFrameMs) / 1000);
    this.#lastFrameMs = performance.now();
    this.#loop();
  }

  tick(t) {
    const now = performance.now();
    // pause 中は #lastFrameMs が止まったままなので再開後の dt が巨大になる。
    // 1フレーム分（約33ms）を上限にクランプして正常な範囲に保つ。
    const dt = Math.min((now - this.#lastFrameMs) / 1000, 0.033);
    this.#lastFrameMs = now;
    this.#lastTickTime = t;
    this.#checkMisses(t);
    this.#updateFx(dt);
    this.#draw(t);
    if (this.#noteIndex >= this.#notes.length && this.#particles.length === 0) {
      this.#fireEnded();
    }
  }

  /**
   * 曲終了・強制終了時に未確定ノートを確定する。
   * ホールド中の tail や noteIndex より後ろの未判定ノートを残したまま
   * rAF/tick を止めるとスコアがほぼ 0 のまま結果画面に行くため、
   * 結果確定前に必ず呼ぶ。
   */
  finalize(t = this.#lastTickTime) {
    if (this.#endedFired) return;
    const notes = this.#notes;
    const win = this.#opts.windows;

    // 1) アクティブなホールドを tail 判定で確定
    for (let lane = 0; lane < this.#laneHold.length; lane++) {
      const holdIdx = this.#laneHold[lane];
      if (holdIdx === -1) continue;
      const note = notes[holdIdx];
      if (!note || !note.holdActive) {
        this.#laneHold[lane] = -1;
        continue;
      }
      const tailJ = note.kind === NoteKind.HOLD
        ? this.#judgeHoldTail(note, t, win)
        : this.#judgeReleaseTail(note, t, win);
      this.#applyHoldTail(note, tailJ);
      this.#laneHold[lane] = -1;
    }

    // 2) noteIndex 以降の未判定ノートを MISS として消化
    //    （ホールド head 未ヒットも含む）
    while (this.#noteIndex < notes.length) {
      const note = notes[this.#noteIndex];
      if (note.holdActive) {
        // 上のループで処理済みのはずだが、念のため
        const tailJ = note.kind === NoteKind.HOLD
          ? this.#judgeHoldTail(note, t, win)
          : this.#judgeReleaseTail(note, t, win);
        this.#applyHoldTail(note, tailJ);
        this.#laneHold[note.lane] = -1;
      } else if (!note.hit && !note.missed) {
        this.#applyJudgment(Judgment.MISS, note);
      }
      this.#noteIndex++;
    }

    // 3) noteIndex より前に残った未判定（レーン跨ぎでヒットされなかったもの等）
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (note.hit || note.missed) continue;
      if (note.holdActive) {
        const tailJ = note.kind === NoteKind.HOLD
          ? this.#judgeHoldTail(note, t, win)
          : this.#judgeReleaseTail(note, t, win);
        this.#applyHoldTail(note, tailJ);
        this.#laneHold[note.lane] = -1;
      } else {
        this.#applyJudgment(Judgment.MISS, note);
      }
    }

    // パーティクル待ちで onEnded が発火しない場合に備えて即通知
    this.#particles.length = 0;
    this.#fireEnded();
  }

  stop() {
    if (this.#animId) {
      cancelAnimationFrame(this.#animId);
      this.#animId = null;
    }
    this.#getTime = null;
  }

  // pressedAt: メインスレッドがキー押下瞬間に記録した currentGameTime()
  //             渡されない場合は #lastTickTime にフォールバック
  pressLane(lane, pressedAt) {
    if (lane < 0 || lane >= this.#opts.laneCount || this.#lanePressed[lane]) {
      return;
    }
    this.#lanePressed[lane] = true;
    this.#uiDirty = true;
    const base = pressedAt !== undefined
      ? pressedAt
      : this.#getTime
      ? this.#getTime()
      : this.#lastTickTime;
    const t = base + (this.#opts.judgeOffset ?? 0);
    if (t >= 0) this.#judgePress(lane, t);
  }

  releaseLane(lane) {
    if (lane < 0 || lane >= this.#opts.laneCount) return;
    this.#lanePressed[lane] = false;
    this.#uiDirty = true;

    // ホールド/リリースtail: リリース時判定
    const holdIdx = this.#laneHold[lane];
    if (holdIdx !== -1) {
      const note = this.#notes[holdIdx];
      const t = this.#lastTickTime;
      const win = this.#opts.windows;
      const tailJ = note.kind === NoteKind.HOLD
        ? this.#judgeHoldTail(note, t, win)
        : this.#judgeReleaseTail(note, t, win);
      this.#applyHoldTail(note, tailJ);
      this.#laneHold[lane] = -1;
    }
  }

  /**
   * HOLDノーツのtail判定（既存音ゲーの「チャージノート」方式に合わせる）。
   * beatmania IIDXのCN、DDRのフリーズアローなどは、離すタイミングそのものを
   * 精密採点せず、終端手前の広い許容窓を超えて押し続けていれば頭の判定を
   * そのまま活かして満点（PERFECT）扱いになる。早めに離した場合のみMISS。
   * → GREAT/GOODのような段階評価は行わない（2値判定）。
   */
  #judgeHoldTail(note, t, win) {
    const target = this.#tailTarget(note);
    const dist = t - target;
    return dist < -win.good ? Judgment.MISS : Judgment.PERFECT;
  }

  /**
   * RELEASEノーツのtail判定（osu!maniaのLN方式に合わせる）。
   * 離すタイミングそのものをheadと同じ判定窓で採点する。
   */
  #judgeReleaseTail(note, t, win) {
    const target = this.#tailTarget(note);
    const dist = t - target;
    if (dist < -win.good) return Judgment.MISS;
    const absDist = dist < 0 ? -dist : dist;
    return absDist <= win.perfect
      ? Judgment.PERFECT
      : absDist <= win.great
      ? Judgment.GREAT
      : Judgment.GOOD;
  }

  /** ノートのtail判定基準時刻。HOLDはendTimeより早め、RELEASEはendTimeそのもの。 */
  #tailTarget(note) {
    return note.kind === NoteKind.HOLD
      ? note.endTime - HOLD_TAIL_LEAD
      : note.endTime;
  }

  resize(w, h, extra = {}) {
    this.#canvas.width = w;
    this.#canvas.height = h;
    if (this.#pCanvas !== this.#canvas) {
      this.#pCanvas.width = w;
      this.#pCanvas.height = h;
    }
    if (this.#uiCanvas !== this.#canvas) {
      this.#uiCanvas.width = w;
      this.#uiCanvas.height = h;
    }
    if (extra.topInset !== undefined) {
      this.#opts.topInset = extra.topInset;
    }
    if (extra.buttonZoneHeight !== undefined) {
      this.#opts.buttonZoneHeight = extra.buttonZoneHeight;
    }
    if (extra.dpr !== undefined && Number(extra.dpr) > 0) {
      this.#opts.dpr = Number(extra.dpr);
    }
    this.#invalidateCache();
  }

  updateOptions(patch = {}) {
    let dirty = false;
    if (patch.scrollSpeed !== undefined) {
      this.#opts.scrollSpeed = patch.scrollSpeed;
      dirty = true;
    }
    if (patch.noteHeight !== undefined) {
      this.#opts.noteHeight = patch.noteHeight;
      dirty = true;
    }
    if (patch.dpr !== undefined && Number(patch.dpr) > 0) {
      this.#opts.dpr = Number(patch.dpr);
      dirty = true;
    }
    if (patch.laneColors !== undefined) {
      this.#opts.laneColors = patch.laneColors;
      dirty = true;
    }
    if (patch.keys !== undefined) {
      this.#opts.keys = patch.keys;
      dirty = true;
    }
    if (patch.glow !== undefined) {
      this.#opts.glow = patch.glow;
      dirty = true;
    }
    if (patch.laneOpacity !== undefined) {
      this.#opts.laneOpacity = patch.laneOpacity;
      dirty = true;
    }
    if (patch.perspective !== undefined) {
      this.#opts.perspective = patch.perspective;
      dirty = true;
    }
    if (patch.uiColor !== undefined) {
      this.#opts.uiColor = patch.uiColor;
      dirty = true;
    }
    if (patch.judgeLineColor !== undefined) {
      this.#opts.judgeLineColor = patch.judgeLineColor;
      dirty = true;
    }
    if (patch.accentColor !== undefined) {
      this.#opts.accentColor = patch.accentColor;
      dirty = true;
    }
    if (patch.laneLineColor !== undefined) {
      this.#opts.laneLineColor = patch.laneLineColor;
      dirty = true;
    }
    if (patch.topInset !== undefined) {
      this.#opts.topInset = patch.topInset;
      dirty = true;
    }
    if (patch.buttonZoneHeight !== undefined) {
      this.#opts.buttonZoneHeight = patch.buttonZoneHeight;
      dirty = true;
    }
    if (patch.judgeOffset !== undefined) {
      this.#opts.judgeOffset = patch.judgeOffset;
    }
    if (patch.judgmentWindows !== undefined) {
      this.#opts.windows = { ...this.#opts.windows, ...patch.judgmentWindows };
    }
    if (dirty) {
      this.#invalidateCache();
      this.#uiDirty = true;
    }
  }

  get score() {
    return Math.round(this.#score);
  }
  get combo() {
    return this.#combo;
  }
  get maxCombo() {
    return this.#maxCombo;
  }
  get totalNotes() {
    return this.#notes.length;
  }
  get judgedNotes() {
    return this.#judgedNotes;
  }
  get perfectCount() {
    return this.#perfectCount;
  }
  get greatCount() {
    return this.#greatCount;
  }
  get goodCount() {
    return this.#goodCount;
  }
  get missCount() {
    return this.#missCount;
  }
  get laneCount() {
    return this.#opts.laneCount;
  }
  get notes() {
    return this.#notes;
  }
  get accuracy() {
    if (!this.#judgedNotes) return 100;
    return (this.#perfectCount * 100 + this.#greatCount * 80 +
      this.#goodCount * 50) /
      this.#judgedNotes;
  }

  // ---- Private: reset / loop ---------------------------------------------

  #resetState() {
    this.#score = this.#combo = this.#maxCombo = 0;
    this.#judgedNotes =
      this.#perfectCount =
      this.#greatCount =
      this.#goodCount =
      this.#missCount =
        0;
    this.#noteIndex = 0;
    this.#drawCursor = 0;
    this.#lastTickTime = 0;
    this.#endedFired = false;
    this.#judgmentFx = [];
    this.#particles = [];
    this.#uiDirty = true;
    this.#lanePressed.fill(false);
    this.#laneLastEmpty.fill(-1e9);
    this.#laneHold.fill(-1);
    this.#holdTrailTimer.fill(0);
    for (let i = 0; i < this.#notes.length; i++) {
      const n = this.#notes[i];
      n.hit = false;
      n.missed = false;
      n.judgment = null;
      n.holdActive = false;
      n.holdHeadJudgment = null;
    }
  }

  #fireEnded() {
    if (this.#endedFired) return;
    this.#endedFired = true;
    this.onEnded?.();
  }

  #invalidateCache() {
    this.#cachedW = 0; // force recalculation
    this.#uiDirty = true;
  }

  #loop() {
    if (!this.#getTime) return;
    const now = performance.now();
    const dt = Math.min((now - this.#lastFrameMs) / 1000, 0.033);
    this.#lastFrameMs = now;
    const t = this.#getTime();
    this.#checkMisses(t);
    this.#updateFx(dt);
    this.#draw(t);
    if (this.#noteIndex >= this.#notes.length && this.#particles.length === 0) {
      this.stop();
      this.#fireEnded();
      return;
    }
    this.#animId = requestAnimationFrame(this.#boundLoop);
  }

  // ---- Private: judgment -------------------------------------------------

  #checkMisses(t) {
    const notes = this.#notes;
    const winGood = this.#opts.windows.good;
    const win = this.#opts.windows;

    // トレースのグラブ判定: レーンが押されていれば通過時に自動 PERFECT。
    // noteIndex より先の TRACE も、すでに押し続けているレーンで拾えるようにする。
    this.#grazeTraceNotes(t, winGood);

    while (this.#noteIndex < notes.length) {
      const note = notes[this.#noteIndex];
      if (note.isHold) {
        if (note.holdActive) {
          // tail 自動判定: 基準時刻（HOLDは早め・RELEASEはendTime）のgood窓を超えたら確定
          const target = this.#tailTarget(note);
          if (t > target + winGood) {
            const tailJ = note.kind === NoteKind.HOLD
              ? this.#judgeHoldTail(note, t, win)
              : this.#judgeReleaseTail(note, t, win);
            this.#applyHoldTail(note, tailJ);
            this.#laneHold[note.lane] = -1; // releaseLane側での二重判定を防ぐ
            this.#noteIndex++;
          } else {
            break;
          }
        } else {
          if (t <= note.startTime + winGood) break;
          if (!note.hit) this.#applyJudgment(Judgment.MISS, note);
          this.#noteIndex++;
        }
      } else if (note.isTrace || note.kind === NoteKind.TRACE) {
        // トレース: 押し続けていれば graze 済み。窓を過ぎたら MISS
        if (t <= note.startTime + winGood) break;
        if (!note.hit) this.#applyJudgment(Judgment.MISS, note);
        this.#noteIndex++;
      } else {
        if (t <= note.startTime + winGood) break;
        if (!note.hit) this.#applyJudgment(Judgment.MISS, note);
        this.#noteIndex++;
      }
    }
  }

  /**
   * トレースノートの接触判定。
   * 判定ライン付近（±good窓）にあり、まだ未判定で、そのレーンが押下中なら
   * タイミング精度を問わず PERFECT として確定する。
   * 押しっぱなしでストリーム全体をなぞる操作を想定。
   */
  #grazeTraceNotes(t, winGood) {
    const notes = this.#notes;
    const start = Math.max(0, this.#noteIndex);
    // 近傍だけスキャン（先のノートはまだ早い）
    for (let i = start; i < notes.length; i++) {
      const note = notes[i];
      if (note.startTime - t > winGood + 0.05) break;
      if (!(note.isTrace || note.kind === NoteKind.TRACE)) continue;
      if (note.hit || note.missed) continue;
      if (!this.#lanePressed[note.lane]) continue;
      // まだかなり先（early すぎ）は拾わない。late 側は checkMisses で MISS にする
      if (t < note.startTime - winGood) continue;
      if (t > note.startTime + winGood) continue;
      note.hit = true;
      this.#applyJudgment(Judgment.PERFECT, note);
      this.#spawnParticles(note.lane, Judgment.PERFECT);
    }
  }

  #judgePress(lane, t) {
    const win = this.#opts.windows;
    const notes = this.#notes;
    let bestIdx = -1, bestDist = Infinity;
    const start = Math.max(0, this.#noteIndex);
    const limit = win.good + 0.05;

    for (let i = start; i < notes.length; i++) {
      const note = notes[i];
      if (note.startTime - t > limit) break;
      if (note.hit || note.missed || note.lane !== lane) continue;
      const dist = Math.abs(t - note.startTime);
      if (dist <= win.good && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      const last = this.#laneLastEmpty[lane];
      if (t - last < win.good) return;
      this.#laneLastEmpty[lane] = t;
      this.#combo = 0;
      this.#judgmentFx.push({ judgment: Judgment.MISS, lane, alpha: 1.0 });
      this.#uiDirty = true;
      return;
    }

    const note = notes[bestIdx];
    // トレースは接触さえすれば常に PERFECT（中間判定なし）
    const isTrace = note.isTrace || note.kind === NoteKind.TRACE;
    const judgment = isTrace
      ? Judgment.PERFECT
      : bestDist <= win.perfect
      ? Judgment.PERFECT
      : bestDist <= win.great
      ? Judgment.GREAT
      : Judgment.GOOD;

    if (note.isHold) {
      // ホールドノート: head のみ判定・holdActiveに移行（tail判定はrelease時）
      note.holdActive = true;
      note.holdHeadJudgment = judgment;
      note.hit = true; // drawCursorが即スキップしないよう注意→hold中は特別扱い
      // combo/score はtail判定時にまとめて付与
      this.#laneHold[lane] = bestIdx;
      this.#spawnParticles(lane, judgment);
      this.#judgmentFx.push({ judgment, lane, alpha: 1.0 });
      this.#uiDirty = true;
    } else {
      note.hit = true;
      this.#applyJudgment(judgment, note);
      this.#spawnParticles(lane, judgment);
    }
  }

  #applyJudgment(judgment, note) {
    note.judgment = judgment;
    const basePerNote = this.#opts.totalNotes > 0
      ? 1_000_000 / this.#opts.totalNotes
      : 0;
    if (judgment === Judgment.MISS) {
      note.missed = true;
      this.#combo = 0;
      this.#missCount++;
    } else {
      this.#combo++;
      if (this.#combo > this.#maxCombo) this.#maxCombo = this.#combo;
      let ratio = 0;
      if (judgment === Judgment.PERFECT) {
        ratio = 1.00;
        this.#perfectCount++;
      } else if (judgment === Judgment.GREAT) {
        ratio = 0.80;
        this.#greatCount++;
      } else {
        ratio = 0.50;
        this.#goodCount++;
      }
      // 毎回 Math.round すると basePerNote が小数のときに加算が潰れて
      // スコアがほぼ 0 のままになる。内部は浮動小数で積み、getter で丸める。
      this.#score += basePerNote * ratio;
    }
    this.#judgedNotes++;
    this.#judgmentFx.push({ judgment, lane: note.lane, alpha: 1.0 });
    this.#uiDirty = true;
    this.onJudgment?.(judgment, this.#combo, this.#score);
  }

  /** ホールドノートのtail判定を確定する */
  #applyHoldTail(note, judgment) {
    note.holdActive = false;
    note.hit = true;
    note.missed = judgment === Judgment.MISS;
    // ホールドは head+tail で1ノート分。スコアは tail 確定時にまとめて付与する
    // （totalNotes は thinNotes 後のノート数）
    const basePerNote = this.#opts.totalNotes > 0
      ? 1_000_000 / this.#opts.totalNotes
      : 0;
    note.judgment = judgment;
    if (judgment === Judgment.MISS) {
      this.#combo = 0;
      this.#missCount++;
    } else {
      this.#combo++;
      if (this.#combo > this.#maxCombo) this.#maxCombo = this.#combo;
      let ratio = 0;
      if (judgment === Judgment.PERFECT) {
        ratio = 1.00;
        this.#perfectCount++;
      } else if (judgment === Judgment.GREAT) {
        ratio = 0.80;
        this.#greatCount++;
      } else {
        ratio = 0.50;
        this.#goodCount++;
      }
      this.#score += basePerNote * ratio;
      this.#spawnParticles(note.lane, judgment);
    }
    this.#judgedNotes++;
    this.#judgmentFx.push({ judgment, lane: note.lane, alpha: 1.0 });
    this.#uiDirty = true;
    this.onJudgment?.(judgment, this.#combo, this.#score);
  }

  // ---- Private: FX -------------------------------------------------------

  #updateFx(dt) {
    // in-place decay（filter で配列生成しない）
    let w = 0;
    for (let i = 0; i < this.#judgmentFx.length; i++) {
      const fx = this.#judgmentFx[i];
      fx.alpha -= dt * 2.0;
      if (fx.alpha > 0) {
        this.#judgmentFx[w++] = fx;
        this.#uiDirty = true;
      }
    }
    this.#judgmentFx.length = w;

    // ホールド中レーン: 一定間隔で上昇する線状の光の粒を発生
    for (let l = 0; l < this.#laneHold.length; l++) {
      if (this.#laneHold[l] === -1) continue;
      this.#holdTrailTimer[l] -= dt;
      if (this.#holdTrailTimer[l] <= 0) {
        this.#holdTrailTimer[l] = 0.018 + Math.random() * 0.012;
        this.#spawnHoldTrailFx(l);
      }
    }

    this.#updateParticles(dt);
  }

  #spawnParticles(lane, judgment) {
    const laneW = this.#canvas.width / this.#opts.laneCount;
    const x = lane * laneW + laneW / 2;
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    const color = this.#opts.laneColors[lane % this.#opts.laneColors.length];
    const d = this.#opts.dpr || 1;

    // 判定の良さでエフェクトの規模を変える（PERFECTが一番派手）
    // 速度・サイズは論理px基準 × dpr（高DPIでも見た目の広がりが同じになる）
    const tier = judgment === Judgment.PERFECT
      ? 2
      : judgment === Judgment.GREAT
      ? 1
      : 0;
    const burstCount = 10 + tier * 4; // 10 / 14 / 18
    const shardCount = 6 + tier * 4; //  6 / 10 / 14
    const sparkCount = 2 + tier * 2; //  2 /  4 /  6
    const ringMax = (42 + tier * 16) * d; // 42 / 58 / 74

    // 1) 放射状バースト（丸い光の粒）
    for (let k = 0; k < burstCount; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (120 + Math.random() * 260) * d;
      const life = 0.35 + Math.random() * 0.45;
      this.#particles.push({
        type: "burst",
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 90 * d,
        life,
        maxLife: life,
        color,
        size: (3 + Math.random() * 4) * d,
      });
    }

    // 2) シャード：回転しながら飛び散る菱形の破片（弾けた質感を出す）
    for (let k = 0; k < shardCount; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (180 + Math.random() * 300) * d;
      const life = 0.28 + Math.random() * 0.35;
      this.#particles.push({
        type: "shard",
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 60 * d,
        life,
        maxLife: life,
        color,
        w: (3 + Math.random() * 3) * d,
        h: (9 + Math.random() * 10) * d,
        rot: Math.random() * 6.2832,
        rotSpeed: (Math.random() - 0.5) * 18,
      });
    }

    // 3) 衝撃波リング：ヒット位置から一瞬で広がって消える光の輪
    const ringLife = 0.28 + tier * 0.05;
    this.#particles.push({
      type: "ring",
      x,
      y,
      life: ringLife,
      maxLife: ringLife,
      color,
      maxRadius: ringMax,
    });

    // 4) スパーク：外側へ速く飛ぶ短い光の線（トレイル表現）
    for (let k = 0; k < sparkCount; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (380 + Math.random() * 220) * d;
      const life = 0.16 + Math.random() * 0.12;
      this.#particles.push({
        type: "spark",
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life,
        maxLife: life,
        color,
      });
    }

    // 5) レーンビーム：レーンの端から端まで（幅いっぱい）光が一瞬上に伸びて消える
    const beamLife = 0.14 + tier * 0.04;
    this.#particles.push({
      type: "beam",
      x,
      y,
      lane,
      life: beamLife,
      maxLife: beamLife,
      color,
      height: (110 + tier * 60) * d,
    });

    // 6) インパクトスパイク：8方向に固定で伸びる星形フラッシュ（弾けた瞬間の「ズドン」感）
    const spikeCount = 8;
    const spikeLen = (34 + tier * 14) * d;
    const spikeLife = 0.16 + tier * 0.03;
    const spikeJitter = (Math.random() - 0.5) * 0.3; // 毎回同じ形にならないよう回転をわずかにずらす
    for (let k = 0; k < spikeCount; k++) {
      const ang = (k / spikeCount) * 6.2832 + spikeJitter;
      this.#particles.push({
        type: "spike",
        x,
        y,
        angle: ang,
        length: spikeLen,
        life: spikeLife,
        maxLife: spikeLife,
        color,
      });
    }

    // 7) PERFECT限定：中心が一瞬白く強く光るフラッシュ
    if (tier === 2) {
      this.#particles.push({
        type: "flash",
        x,
        y,
        life: 0.12,
        maxLife: 0.12,
        color: "#ffffff",
        radius: 46 * d,
      });
    }
  }

  /** ホールド保持中: 判定ラインから立ち上る線状の光の粒（丸いリングではなく縦の光跡） */
  #spawnHoldTrailFx(lane) {
    const d = this.#opts.dpr || 1;
    const laneW = this.#canvas.width / this.#opts.laneCount;
    const cx = lane * laneW + laneW / 2;
    const x = cx + (Math.random() - 0.5) * laneW;
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    const color = this.#opts.laneColors[lane % this.#opts.laneColors.length];
    const life = 0.4 + Math.random() * 0.3;
    this.#particles.push({
      type: "trail",
      x,
      y,
      vx: (Math.random() - 0.5) * 15 * d,
      vy: (-170 - Math.random() * 90) * d,
      life,
      maxLife: life,
      color,
      size: (2.5 + Math.random() * 3) * d,
    });
  }

  #updateParticles(dt) {
    const g = 480 * (this.#opts.dpr || 1) * dt;
    let w = 0;
    for (let i = 0; i < this.#particles.length; i++) {
      const p = this.#particles[i];
      switch (p.type) {
        case "spark":
          // 空気抵抗で急減速させ、短い光跡らしい動きにする
          p.vx *= 1 - 6 * dt;
          p.vy *= 1 - 6 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          break;
        case "shard":
          p.vy += g * 0.6;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rot += p.rotSpeed * dt;
          break;
        case "trail":
          // 上昇するエネルギー粒子。ゆるく左右に揺れる
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx += Math.sin((p.life + p.x) * 6) * 6 * dt;
          break;
        case "ring":
        case "flash":
        case "beam":
        case "spike":
          // 位置は固定。life の減少だけで拡大／消滅を表現する
          break;
        case "burst":
        default:
          p.vy += g;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          break;
      }
      p.life -= dt;
      if (p.life > 0) this.#particles[w++] = p;
    }
    this.#particles.length = w;
  }

  // ---- Private: drawing --------------------------------------------------

  #draw(t) {
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    const o = this.#opts;

    // キャッシュ更新（リサイズ時のみ再計算）
    // フォントサイズは論理px基準 × dpr で、高DPIでも CSS 上の見た目が同じになるようにする。
    if (W !== this.#cachedW || H !== this.#cachedH) {
      this.#cachedW = W;
      this.#cachedH = H;
      this.#cachedHitY = H - o.buttonZoneHeight;
      this.#cachedLaneW = W / o.laneCount;
      const d = o.dpr || 1;
      this.#cachedBtnFont = `bold ${
        Math.min(22 * d, this.#cachedLaneW * 0.28).toFixed(0)
      }px monospace`;
      this.#cachedComboFont = `bold ${
        Math.min(44 * d, W * 0.09).toFixed(0)
      }px sans-serif`;
      this.#uiDirty = true;
    }

    const hitY = this.#cachedHitY;
    const laneW = this.#cachedLaneW;
    const btnBot = hitY + o.buttonZoneHeight;

    // ノートレイヤー（毎フレーム）
    // ボタンもここに描くことで、missノートが後から重なり突き抜けて見える
    const ctx = this.#ctx;
    ctx.clearRect(0, 0, W, H);
    this.#drawLaneSeparators(ctx, W, H, laneW, hitY, btnBot, o);
    this.#drawButtons(ctx, laneW, hitY, H, W, btnBot, o);
    this.#drawNotes(ctx, t, laneW, hitY, H, btnBot, o);

    // パーティクルレイヤー（毎フレーム）
    const pCtx = this.#pCtx;
    pCtx.clearRect(0, 0, W, H);
    if (this.#particles.length > 0) this.#drawParticles(pCtx, o);
    this.#drawHoldBeam(pCtx, laneW, hitY, btnBot, o);

    // UIレイヤー（状態変化時のみ）: HUD・判定FXのみ
    if (this.#uiDirty) {
      const uCtx = this.#uiCtx;
      uCtx.clearRect(0, 0, W, H);
      this.#drawJudgmentFx(uCtx, laneW, hitY, o);
      this.#drawHUD(uCtx, W, H, o);
      this.#uiDirty = false;
    }
  }

  // ---- Perspective helpers ------------------------------------------------
  // perspScale(y, hitY, p): y位置でのX方向スケール (p=0:変換なし, p=1:最大)
  #perspScale(y, hitY, p) {
    if (!p) return 1;
    const t = y / hitY;
    return 1 - p + p * t;
  }

  // 基準点を btnBot（画面最下端）にしてパース計算
  // y=btnBot → scale=1 → フル幅（左端0、右端W）
  // y=0      → scale=1-p → 中央に収束
  #perspX(laneIdx, laneW, W, y, hitY, p, btnBot) {
    const xFull = laneIdx * laneW; // laneW=W/N なので l=0→0, l=N→W
    if (!p) return xFull;
    const ref = btnBot ?? hitY; // 基準Y（ここでscale=1）
    const cx = W / 2;
    const sc = 1 - p + p * (y / ref);
    return cx + (xFull - cx) * sc;
  }

  #perspLaneW(laneW, _W, y, hitY, p, btnBot) {
    if (!p) return laneW;
    const ref = btnBot ?? hitY;
    return laneW * (1 - p + p * (y / ref));
  }

  #drawLaneSeparators(ctx, W, _H, laneW, hitY, btnBot, o) {
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    // レーン区切り線・疑似床グラデーション用の色（未設定なら uiColor にフォールバック）
    const lineColor = o.laneLineColor || o.uiColor;
    // laneOpacity と連動させる。元は 0.10 固定で、レーンの不透明度設定を変えても
    // ほとんど見た目が変わらなかったため、0(透明)〜1(最大)でしっかり差が出る値にする。
    const t = Math.max(0, Math.min(1, o.laneOpacity ?? 0.35));

    // 外枠・内側境界線
    // 下端 = btnBot（画面最下端）で左端0・右端W、上端 y=0 で中央に収束
    ctx.strokeStyle = withAlpha(lineColor, 0.35 * t);
    ctx.lineWidth = 1 * d;
    for (let l = 0; l <= o.laneCount; l++) {
      const xBot = l === 0
        ? 0
        : l === o.laneCount
        ? W
        : this.#perspX(l, laneW, W, btnBot, hitY, p, btnBot);
      const xTop = this.#perspX(l, laneW, W, 0, hitY, p, btnBot);
      ctx.beginPath();
      ctx.moveTo(xBot, btnBot);
      ctx.lineTo(xTop, 0);
      ctx.stroke();
    }

    // 疑似床グラデーション
    if (p > 0) {
      const xTopL = this.#perspX(0, laneW, W, 0, hitY, p, btnBot);
      const xTopR = this.#perspX(o.laneCount, laneW, W, 0, hitY, p, btnBot);
      const grad = ctx.createLinearGradient(0, 0, 0, btnBot);
      grad.addColorStop(0, withAlpha(lineColor, 0.0));
      grad.addColorStop(1, withAlpha(lineColor, 0.14 * t));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xTopL, 0);
      ctx.lineTo(xTopR, 0);
      ctx.lineTo(W, btnBot);
      ctx.lineTo(0, btnBot);
      ctx.closePath();
      ctx.fill();
    }

    // 常時発光する判定ライン（judgeLineColor 未設定時は uiColor にフォールバック）
    const judgeColor = o.judgeLineColor || o.uiColor;
    ctx.save();
    ctx.shadowColor = withAlpha(judgeColor, 0.9);
    ctx.shadowBlur = 18 * d;
    ctx.strokeStyle = withAlpha(judgeColor, 0.92);
    ctx.lineWidth = 3 * d;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(W, hitY);
    ctx.stroke();
    ctx.shadowBlur = 36 * d;
    ctx.strokeStyle = withAlpha(judgeColor, 0.35);
    ctx.lineWidth = 7 * d;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(W, hitY);
    ctx.stroke();
    ctx.restore();
  }

  #drawNotes(ctx, t, laneW, hitY, H, btnBot, o) {
    const notes = this.#notes;
    const d = o.dpr || 1;
    // scrollSpeed / noteHeight は論理px基準 → canvas 座標では dpr 倍
    const speed = o.scrollSpeed * d;
    const lookahead = H / speed + 0.3 + (o.startDelay ?? 0);
    // drawCursorスキップ判定用: 画面下端より下まで落下したノートを確認する秒数
    // const trailSec  = (H + o.buttonZoneHeight) / speed;

    // drawCursor スキップ条件:
    //   タップ hit済み          → 即スキップ
    //   ホールド 完了(hit&&!holdActive) → 即スキップ
    //   miss/holdActive         → endTime が画面底を抜けるまで保持
    //   未hit                   → startTime が画面外に出るまで保持
    while (this.#drawCursor < notes.length) {
      const n = notes[this.#drawCursor];
      if (n.holdActive) break;
      if (n.isHold && !n.hit && !n.missed) break;
      if (n.hit && !n.holdActive) {
        // タップhit済み or ホールド完了 → スキップ
        this.#drawCursor++;
        continue;
      }
      // miss or 未hit通過: endTime のY座標が画面底を抜けるまで保持
      const yBotTail = hitY - (n.endTime - t) * speed;
      if (yBotTail <= H) break;
      this.#drawCursor++;
    }

    const glow = o.glow;
    const laneColors = o.laneColors;
    const laneColorLen = laneColors.length;
    const noteHeight = o.noteHeight * d;
    const cW = this.#canvas.width;
    const p = o.perspective ?? 0;
    const pad = Math.max(2 * d, laneW * 0.05);

    const prevAlpha = ctx.globalAlpha;
    const prevShadow = ctx.shadowBlur;
    ctx.shadowBlur = glow ? 14 * d : 0;

    // 台形ノートを描くヘルパー（p=0 のとき roundRect にフォールバック）
    const drawTrap = (laneIdx, yTop, yBot, fillStyle, alpha, r) => {
      const scBot = this.#perspScale(yBot, hitY, p);
      const scTop = this.#perspScale(yTop, hitY, p);
      const xBotL = this.#perspX(laneIdx, laneW, cW, yBot, hitY, p, btnBot) +
        pad * scBot;
      const xBotR =
        this.#perspX(laneIdx + 1, laneW, cW, yBot, hitY, p, btnBot) -
        pad * scBot;
      const xTopL = this.#perspX(laneIdx, laneW, cW, yTop, hitY, p, btnBot) +
        pad * scTop;
      const xTopR =
        this.#perspX(laneIdx + 1, laneW, cW, yTop, hitY, p, btnBot) -
        pad * scTop;
      if (xBotR <= xBotL || xTopR <= xTopL) return;
      ctx.globalAlpha = alpha < 0 ? 0 : alpha;
      ctx.fillStyle = fillStyle;
      if (!p) {
        const h = yBot - yTop;
        ctx.beginPath();
        ctx.roundRect(
          xBotL,
          yTop,
          xBotR - xBotL,
          h,
          Math.min(r, (xBotR - xBotL) / 2, h / 2),
        );
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(xBotL, yBot);
        ctx.lineTo(xBotR, yBot);
        ctx.lineTo(xTopR, yTop);
        ctx.lineTo(xTopL, yTop);
        ctx.closePath();
        ctx.fill();
      }
    };

    // ホールド/リリースノート専用：全体の輪郭を縁取りするヘルパー。
    // 半透明のまま隣接/重なると境目が分からなくなるため、外周に線を引いて区切りをはっきりさせる。
    const drawTrapStroke = (
      laneIdx,
      yTop,
      yBot,
      strokeStyle,
      alpha,
      lineWidth,
    ) => {
      const scBot = this.#perspScale(yBot, hitY, p);
      const scTop = this.#perspScale(yTop, hitY, p);
      const xBotL = this.#perspX(laneIdx, laneW, cW, yBot, hitY, p, btnBot) +
        pad * scBot;
      const xBotR =
        this.#perspX(laneIdx + 1, laneW, cW, yBot, hitY, p, btnBot) -
        pad * scBot;
      const xTopL = this.#perspX(laneIdx, laneW, cW, yTop, hitY, p, btnBot) +
        pad * scTop;
      const xTopR =
        this.#perspX(laneIdx + 1, laneW, cW, yTop, hitY, p, btnBot) -
        pad * scTop;
      if (xBotR <= xBotL || xTopR <= xTopL) return;
      ctx.globalAlpha = alpha < 0 ? 0 : alpha;
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      if (!p) {
        const h = yBot - yTop;
        ctx.beginPath();
        ctx.roundRect(
          xBotL,
          yTop,
          xBotR - xBotL,
          h,
          Math.min(8 * d, (xBotR - xBotL) / 2, h / 2),
        );
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(xBotL, yBot);
        ctx.lineTo(xBotR, yBot);
        ctx.lineTo(xTopR, yTop);
        ctx.lineTo(xTopL, yTop);
        ctx.closePath();
        ctx.stroke();
      }
    };

    for (let i = this.#drawCursor; i < notes.length; i++) {
      const note = notes[i];

      // ホールド完了 / タップhit → 描画不要
      if (note.hit && !note.holdActive) continue;

      const dt = note.startTime - t;
      if (dt > lookahead) break;

      const yBot = hitY - (note.startTime - t) * speed;
      const yTop = hitY - (note.endTime - t) * speed;

      if (yTop > H) continue;
      if (yBot < 0) continue;

      const color = laneColors[note.lane % laneColorLen];
      const isTrace = note.isTrace || note.kind === NoteKind.TRACE;
      // HOLDノーツは彩度を落とした色にして、レーン色そのままのRELEASE/TAPと
      // パッと見で区別できるようにする（マーカーの有無と合わせて二重に判別しやすくする）。
      // TRACE は少し明るめ＋細帯で「なぞる」感を出す。
      const bodyColor = note.isHold && note.kind === NoteKind.HOLD
        ? desaturateColor(color, 0.55)
        : isTrace
        ? color
        : color;
      const laneIdx = note.lane;
      const botNoteW = this.#perspLaneW(laneW, cW, yBot, hitY, p, btnBot) -
        pad * 2 * this.#perspScale(yBot, hitY, p);
      const r = Math.min(8 * d, botNoteW / 2);
      const traceH = noteHeight * TRACE_HEIGHT_RATIO;

      ctx.shadowColor = bodyColor;

      // ── holdActive: head通過済み・tail待ち ──────────────────────────
      if (note.holdActive) {
        const drawTop = yTop < 0 ? 0 : yTop;
        const drawBot = hitY + o.buttonZoneHeight * 0.35;
        const drawH = drawBot - drawTop;
        if (drawH <= 0) continue;
        const pulse = 0.75 + 0.25 * Math.sin(t * 8);
        if (note.kind === NoteKind.RELEASE) {
          // リリースノーツ: 終端に小さめの不透明キャップを乗せ、
          // 本体（半透明）との境目はグラデーションでなめらかになじませる。
          const capOffset = Math.min(
            0.49,
            (noteHeight * CAP_HEIGHT_RATIO) / drawH,
          );
          const blendOffset = Math.min(
            0.49 - capOffset,
            (CAP_BLEND_PX * d) / drawH,
          );
          const opaque = withAlpha(bodyColor, pulse);
          const soft = withAlpha(bodyColor, HOLD_OPACITY * pulse);
          const grad = ctx.createLinearGradient(0, drawTop, 0, drawBot);
          grad.addColorStop(0, opaque);
          grad.addColorStop(capOffset, opaque);
          grad.addColorStop(capOffset + blendOffset, soft);
          grad.addColorStop(1, soft);
          drawTrap(laneIdx, drawTop, drawBot, grad, 1, r);
        } else {
          drawTrap(
            laneIdx,
            drawTop,
            drawBot,
            bodyColor,
            HOLD_OPACITY * pulse,
            r,
          );
        }
        ctx.shadowBlur = 0;
        drawTrapStroke(laneIdx, drawTop, drawBot, o.uiColor, 0.9, 2 * d);
        ctx.shadowBlur = glow ? 14 * d : 0;
        continue;
      }

      // ── miss / 判定ライン通過後の未hitノート ─────────────────────────
      if (note.missed || (!note.hit && yBot > hitY)) {
        const drawBot = yBot > H ? H : yBot;
        // タップ/トレースは通過後も fixed 高さのまま（duration由来の長さにしない）
        const hMiss = isTrace ? traceH : noteHeight;
        const drawTop = note.isHold
          ? (yTop < 0 ? 0 : yTop)
          : Math.max(0, drawBot - hMiss);
        if (drawBot <= drawTop) continue;
        const baseAlpha = note.isHold
          ? HOLD_OPACITY
          : isTrace
          ? TRACE_OPACITY
          : 1;
        drawTrap(laneIdx, drawTop, drawBot, bodyColor, baseAlpha * 0.55, r);
        continue;
      }

      // ── 通常（未hit タップ / トレース / ホールド・リリース未到達） ─────
      const isHold = note.isHold;
      const drawTop = yTop < 0 ? 0 : yTop;
      const drawBot = yBot > hitY ? hitY : yBot;
      if (drawBot <= drawTop && !isTrace) continue;

      if (isHold) {
        // 半透明の本体と、押す/離す位置の不透明キャップ（タップノート同様）を
        // 1本のグラデーションとして描き、境目をわずかになじませる。
        //   HOLD    : 頭のキャップのみ。終端はそのまま透明にフェードさせ、
        //             「正確に離す必要はない」ことを示す。
        //   RELEASE : 頭・終端の両方に小さめのキャップを乗せ、
        //             「正確に押して正確に離す」ことを示す。
        // タップノートと見分けが付くよう、キャップはタップより小さく・
        // 本体とのなじみ幅は広めにとる。
        const total = drawBot - drawTop;
        const capOffset = Math.min(
          0.49,
          (noteHeight * CAP_HEIGHT_RATIO) / total,
        );
        const blendOffset = Math.min(
          0.49 - capOffset,
          (CAP_BLEND_PX * d) / total,
        );
        const opaque = withAlpha(bodyColor, 1);
        const soft = withAlpha(bodyColor, HOLD_OPACITY);

        const grad = ctx.createLinearGradient(0, drawTop, 0, drawBot);
        if (note.kind === NoteKind.RELEASE) {
          grad.addColorStop(0, opaque);
          grad.addColorStop(capOffset, opaque);
          grad.addColorStop(capOffset + blendOffset, soft);
        } else {
          // HOLD: 終端（endTime側 = offset0）は完全に透明までフェードさせる
          const tailFadeOffset = Math.min(0.3, (60 * d) / total);
          grad.addColorStop(0, withAlpha(bodyColor, 0));
          grad.addColorStop(tailFadeOffset, soft);
        }
        grad.addColorStop(1 - capOffset - blendOffset, soft);
        grad.addColorStop(1 - capOffset, opaque);
        grad.addColorStop(1, opaque);
        drawTrap(laneIdx, drawTop, drawBot, grad, 1, r);

        ctx.shadowBlur = 0;
        drawTrapStroke(laneIdx, drawTop, drawBot, o.uiColor, 0.9, 2 * d);
        ctx.shadowBlur = glow ? 14 * d : 0;
      } else if (isTrace) {
        // トレースノート: 細い本体 ＋ 直後のトレースまで帯で連結（くっついた表示）
        // 連結帯は「このノート → 次ノート」の区間だけ描き、二重描画を避ける。
        const tapBot = Math.min(hitY, yBot);
        const tapTop = Math.max(0, tapBot - traceH);
        if (tapBot > tapTop) {
          // 本体は少し幅を狭めて「細い線」感を出す
          const narrowPad = pad + Math.max(2 * d, laneW * 0.12);
          const drawTrapNarrow = (yT, yB, fill, alpha) => {
            const scB = this.#perspScale(yB, hitY, p);
            const scT = this.#perspScale(yT, hitY, p);
            const xBL = this.#perspX(laneIdx, laneW, cW, yB, hitY, p, btnBot) +
              narrowPad * scB;
            const xBR =
              this.#perspX(laneIdx + 1, laneW, cW, yB, hitY, p, btnBot) -
              narrowPad * scB;
            const xTL = this.#perspX(laneIdx, laneW, cW, yT, hitY, p, btnBot) +
              narrowPad * scT;
            const xTR =
              this.#perspX(laneIdx + 1, laneW, cW, yT, hitY, p, btnBot) -
              narrowPad * scT;
            if (xBR <= xBL || xTR <= xTL) return;
            ctx.globalAlpha = alpha < 0 ? 0 : alpha;
            ctx.fillStyle = fill;
            if (!p) {
              const h = yB - yT;
              ctx.beginPath();
              ctx.roundRect(
                xBL,
                yT,
                xBR - xBL,
                h,
                Math.min(4 * d, (xBR - xBL) / 2, h / 2),
              );
              ctx.fill();
            } else {
              ctx.beginPath();
              ctx.moveTo(xBL, yB);
              ctx.lineTo(xBR, yB);
              ctx.lineTo(xTR, yT);
              ctx.lineTo(xTL, yT);
              ctx.closePath();
              ctx.fill();
            }
          };

          drawTrapNarrow(tapTop, tapBot, bodyColor, TRACE_OPACITY);

          // 次のトレースまで細い連結帯を伸ばす（ノート同士がくっついて見える）
          if (note.streamNext >= 0) {
            const next = notes[note.streamNext];
            if (next && !next.hit && !next.missed) {
              const nextYBot = hitY - (next.startTime - t) * speed;
              const linkTop = Math.max(0, nextYBot - traceH * 0.5);
              const linkBot = Math.min(hitY, tapTop);
              if (linkBot > linkTop) {
                // 連結帯はさらに細く・半透明
                const linkPad = pad + Math.max(4 * d, laneW * 0.22);
                const scB = this.#perspScale(linkBot, hitY, p);
                const scT = this.#perspScale(linkTop, hitY, p);
                const xBL =
                  this.#perspX(laneIdx, laneW, cW, linkBot, hitY, p, btnBot) +
                  linkPad * scB;
                const xBR =
                  this.#perspX(
                    laneIdx + 1,
                    laneW,
                    cW,
                    linkBot,
                    hitY,
                    p,
                    btnBot,
                  ) - linkPad * scB;
                const xTL =
                  this.#perspX(laneIdx, laneW, cW, linkTop, hitY, p, btnBot) +
                  linkPad * scT;
                const xTR =
                  this.#perspX(
                    laneIdx + 1,
                    laneW,
                    cW,
                    linkTop,
                    hitY,
                    p,
                    btnBot,
                  ) - linkPad * scT;
                if (xBR > xBL && xTR > xTL) {
                  ctx.globalAlpha = TRACE_OPACITY * 0.55;
                  ctx.fillStyle = bodyColor;
                  ctx.beginPath();
                  if (!p) {
                    ctx.roundRect(
                      xBL,
                      linkTop,
                      xBR - xBL,
                      linkBot - linkTop,
                      Math.min(3 * d, (xBR - xBL) / 2),
                    );
                  } else {
                    ctx.moveTo(xBL, linkBot);
                    ctx.lineTo(xBR, linkBot);
                    ctx.lineTo(xTR, linkTop);
                    ctx.lineTo(xTL, linkTop);
                    ctx.closePath();
                  }
                  ctx.fill();
                }
              }
            }
          }

          // 細い縁取りでタップと区別
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 0.85;
          ctx.strokeStyle = o.uiColor;
          ctx.lineWidth = 1.5 * d;
          {
            const scB = this.#perspScale(tapBot, hitY, p);
            const scT = this.#perspScale(tapTop, hitY, p);
            const xBL =
              this.#perspX(laneIdx, laneW, cW, tapBot, hitY, p, btnBot) +
              narrowPad * scB;
            const xBR =
              this.#perspX(laneIdx + 1, laneW, cW, tapBot, hitY, p, btnBot) -
              narrowPad * scB;
            const xTL =
              this.#perspX(laneIdx, laneW, cW, tapTop, hitY, p, btnBot) +
              narrowPad * scT;
            const xTR =
              this.#perspX(laneIdx + 1, laneW, cW, tapTop, hitY, p, btnBot) -
              narrowPad * scT;
            if (xBR > xBL && xTR > xTL) {
              ctx.beginPath();
              if (!p) {
                ctx.roundRect(
                  xBL,
                  tapTop,
                  xBR - xBL,
                  tapBot - tapTop,
                  Math.min(4 * d, (xBR - xBL) / 2),
                );
              } else {
                ctx.moveTo(xBL, tapBot);
                ctx.lineTo(xBR, tapBot);
                ctx.lineTo(xTR, tapTop);
                ctx.lineTo(xTL, tapTop);
                ctx.closePath();
              }
              ctx.stroke();
            }
          }
          ctx.shadowBlur = glow ? 14 * d : 0;
        }
      } else {
        // タップノート: 実際の duration に関わらず、見た目の高さは固定（noteHeight）。
        // 実演奏データでは noteOff と次の noteOn がほぼ密着しているケースが多く、
        // duration をそのまま長さにすると隣接ノート同士がくっついて見えたり、
        // ホールドノートとの区別が付きにくくなるため、タップは常に短い固定長で描く。
        const tapBot = drawBot;
        const tapTop = Math.max(0, tapBot - noteHeight);
        drawTrap(laneIdx, tapTop, tapBot, bodyColor, 1, r);
        ctx.shadowBlur = glow ? 14 * d : 0;
      }
    }

    ctx.globalAlpha = prevAlpha;
    ctx.shadowBlur = prevShadow;
  }

  #drawButtons(ctx, laneW, hitY, _H, W, btnBot, o) {
    const btnH = o.buttonZoneHeight;
    const glow = o.glow;
    const colors = o.laneColors;
    const font = this.#cachedBtnFont;
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    // レーンの不透明度は 0(完全に透明)〜1(最大まで濃く)の通常の opacity と同じ考え方。
    // 元の16進アルファ決め打ち値（0d/44/40/88/22/cc 等）はどれも薄めだったため、
    // 1.0 のときにしっかり見える強さまで届くよう目標値を引き上げてある。
    const t = Math.max(0, Math.min(1, o.laneOpacity ?? 0.35));
    const fillIdleA = t * 0.6;
    const borderIdleA = t * 0.9;
    const fillPressedA = t * 0.75;
    const gradTopA = t * 0.9;
    const gradBottomA = t * 0.25;
    const borderPressedA = t;

    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // ボタン下端: 0〜W にフル幅で均等配置（フィールドの逆、外側に広がる）
    for (let l = 0; l < o.laneCount; l++) {
      const color = colors[l % colors.length];
      const pressed = this.#lanePressed[l];

      const topL = this.#perspX(l, laneW, W, hitY, hitY, p, btnBot);
      const topR = this.#perspX(l + 1, laneW, W, hitY, hitY, p, btnBot);
      const botL = this.#perspX(l, laneW, W, btnBot, hitY, p, btnBot);
      const botR = this.#perspX(l + 1, laneW, W, btnBot, hitY, p, btnBot);

      const trapPath = () => {
        ctx.beginPath();
        ctx.moveTo(topL, hitY);
        ctx.lineTo(topR, hitY);
        ctx.lineTo(botR, btnBot);
        ctx.lineTo(botL, btnBot);
        ctx.closePath();
      };

      if (pressed) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = (glow ? 30 : 12) * d;
        ctx.fillStyle = withAlpha(color, fillPressedA);
        trapPath();
        ctx.fill();
        const grad = ctx.createLinearGradient(0, hitY, 0, btnBot);
        grad.addColorStop(0, withAlpha(color, gradTopA));
        grad.addColorStop(0.4, withAlpha(color, gradBottomA));
        grad.addColorStop(1, "transparent");
        ctx.shadowBlur = 0;
        ctx.fillStyle = grad;
        trapPath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = withAlpha(color, fillIdleA);
        trapPath();
        ctx.fill();
      }

      // レーン境界線（全境界: 0〜laneCount）
      ctx.strokeStyle = withAlpha(
        color,
        pressed ? borderPressedA : borderIdleA,
      );
      ctx.lineWidth = 1 * d;
      // 左辺
      ctx.beginPath();
      ctx.moveTo(topL, hitY);
      ctx.lineTo(botL, btnBot);
      ctx.stroke();
      // 最右端レーンだけ右辺も
      if (l === o.laneCount - 1) {
        ctx.beginPath();
        ctx.moveTo(topR, hitY);
        ctx.lineTo(botR, btnBot);
        ctx.stroke();
      }

      // キーラベル：台形重心
      const cx = (topL + topR + botL + botR) / 4;
      const cy = hitY + btnH / 2;
      // 待機中は accentColor（設定可能・未設定なら uiColor）、押下中はレーン色で発光。
      ctx.shadowColor = color;
      ctx.shadowBlur = pressed ? (glow ? 16 : 8) * d : 0;
      drawText(
        ctx,
        (o.keys[l] ?? l + 1).toString().toUpperCase(),
        cx,
        cy,
        pressed ? color : (o.accentColor || o.uiColor),
      );
      ctx.shadowBlur = 0;
    }
  }

  #drawJudgmentFx(ctx, laneW, hitY, o) {
    if (!this.#judgmentFx.length) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const glow = o.glow;
    const d = o.dpr || 1;
    for (let i = 0; i < this.#judgmentFx.length; i++) {
      const fx = this.#judgmentFx[i];
      const def = FX_TABLE[fx.judgment];
      const x = fx.lane * laneW + laneW / 2;
      const y = hitY - (55 + (1 - fx.alpha) * 28) * d;
      ctx.globalAlpha = fx.alpha < 0 ? 0 : fx.alpha;
      ctx.shadowColor = def.color;
      ctx.shadowBlur = glow ? 10 * d : 0;
      ctx.font = `bold ${def.size * d}px sans-serif`;
      drawText(ctx, def.text, x, y, o.accentColor || o.uiColor);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  #drawParticles(ctx, o) {
    const glow = o.glow;
    const d = o.dpr || 1;
    const prevComposite = ctx.globalCompositeOperation;
    // 加算合成にすることで重なった光が明るく発光し、単なる不透明な粒より派手に見える
    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < this.#particles.length; i++) {
      const p = this.#particles[i];
      const a = p.life / p.maxLife;
      const alpha = a < 0 ? 0 : a;
      ctx.globalAlpha = alpha;

      switch (p.type) {
        case "ring": {
          // 時間経過とともに半径が広がり、太さと不透明度が落ちていく光の輪
          const radius = p.maxRadius * (1 - a);
          ctx.shadowColor = p.color;
          ctx.shadowBlur = glow ? 14 * d : 0;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = (1 + 3 * a) * d;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.1, radius), 0, 6.2832);
          ctx.stroke();
          break;
        }
        case "beam": {
          // レーンを貫く光の柱：ヒット位置から上下に伸びて素早く消える
          // 台形パースが掛かっている場合、上端と下端でレーン幅が変わるため
          // #perspX で実際のレーン境界に追従させる（そうしないと上端がレーン外へはみ出す）
          ctx.shadowBlur = 0;
          const h = p.height * (1 - a * 0.25);
          const hitY = this.#cachedHitY;
          const laneW = this.#cachedLaneW;
          const W = this.#canvas.width;
          const btnBot = hitY + o.buttonZoneHeight;
          const persp = o.perspective ?? 0;
          const yBot = p.y + h * 0.15;
          const yTop = p.y - h;
          const xBotL = this.#perspX(
            p.lane,
            laneW,
            W,
            yBot,
            hitY,
            persp,
            btnBot,
          );
          const xBotR = this.#perspX(
            p.lane + 1,
            laneW,
            W,
            yBot,
            hitY,
            persp,
            btnBot,
          );
          const xTopL = this.#perspX(
            p.lane,
            laneW,
            W,
            yTop,
            hitY,
            persp,
            btnBot,
          );
          const xTopR = this.#perspX(
            p.lane + 1,
            laneW,
            W,
            yTop,
            hitY,
            persp,
            btnBot,
          );
          const grad = ctx.createLinearGradient(p.x, yBot, p.x, yTop);
          grad.addColorStop(0, withAlpha(p.color, 0.9));
          grad.addColorStop(0.5, withAlpha(p.color, 0.35));
          grad.addColorStop(1, withAlpha(p.color, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(xBotL, yBot);
          ctx.lineTo(xBotR, yBot);
          ctx.lineTo(xTopR, yTop);
          ctx.lineTo(xTopL, yTop);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "flash": {
          // 中心が一瞬強く光るラジアルグラデーション（PERFECT限定）
          ctx.shadowBlur = 0;
          const fr = p.radius ?? 46 * d;
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, fr);
          grad.addColorStop(0, p.color);
          grad.addColorStop(1, "transparent");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, fr, 0, 6.2832);
          ctx.fill();
          break;
        }
        case "spark": {
          // 進行方向へ短い光跡を残しながら飛ぶ線パーティクル
          ctx.shadowColor = p.color;
          ctx.shadowBlur = glow ? 8 * d : 0;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2 * d;
          const trail = 0.02;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * trail, p.y - p.vy * trail);
          ctx.stroke();
          break;
        }
        case "spike": {
          // 8方向に伸びる先細りの光の棘：短時間で縮みながら消える「ズドン」演出
          const len = p.length * a;
          const dx = Math.cos(p.angle) * len;
          const dy = Math.sin(p.angle) * len;
          ctx.shadowColor = p.color;
          ctx.shadowBlur = glow ? 12 * d : 0;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = (4 * a + 0.5) * d;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + dx, p.y + dy);
          ctx.stroke();
          break;
        }
        case "shard": {
          // 回転しながら飛び散る菱形の破片（弾けた質感）
          ctx.shadowColor = p.color;
          ctx.shadowBlur = glow ? 8 * d : 0;
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(0, -p.h / 2);
          ctx.lineTo(p.w / 2, 0);
          ctx.lineTo(0, p.h / 2);
          ctx.lineTo(-p.w / 2, 0);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case "trail": {
          // ホールド保持中の上昇スパーク：丸ではなく縦に伸びる光の線
          ctx.shadowColor = p.color;
          ctx.shadowBlur = glow ? 8 * d : 0;
          ctx.strokeStyle = p.color;
          const len = (10 + 16 * a) * d;
          ctx.lineWidth = p.size * (0.6 + 0.6 * a);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y + len / 2);
          ctx.lineTo(p.x, p.y - len / 2);
          ctx.stroke();
          break;
        }
        case "burst":
        default: {
          const r = p.size * (0.5 + 0.5 * a);
          ctx.shadowColor = p.color;
          ctx.shadowBlur = glow ? 6 * d : 0;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, 6.2832);
          ctx.fill();
          break;
        }
      }
    }

    ctx.globalCompositeOperation = prevComposite;
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  /** ホールド中レーンに常時描画するエネルギービーム。
   *  元実装の"beam"パーティクルと同じ #perspX 台形計算を使うことで、
   *  パースペクティブ設定時にレーン境界へ正しく追従させる（fillRectだと
   *  遠近感を無視した直線矩形になってしまうため、台形パスで描画する）。 */
  #drawHoldBeam(ctx, laneW, hitY, btnBot, o) {
    let any = false;
    for (let l = 0; l < this.#laneHold.length; l++) {
      if (this.#laneHold[l] !== -1) {
        any = true;
        break;
      }
    }
    if (!any) return;

    const d = o.dpr || 1;
    const W = this.#canvas.width;
    const persp = o.perspective ?? 0;
    const t = this.#lastTickTime;
    const beamH = Math.min(160 * d, hitY * 0.6) *
      (0.92 + 0.08 * Math.sin(t * 1.5));
    const prevComposite = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";

    for (let l = 0; l < this.#laneHold.length; l++) {
      if (this.#laneHold[l] === -1) continue;
      const color = o.laneColors[l % o.laneColors.length];
      // 複数の緩やかな波を重ねて不規則にふわふわ揺れる呼吸感を出す
      // （単一の速いsinだと機械的に脈打つだけになってしまうため）
      const phase = l * 1.7; // レーンごとに位相をずらし、全レーンが同期して見えないようにする
      const breathe = 0.5 +
        0.28 * Math.sin(t * 1.8 + phase) +
        0.16 * Math.sin(t * 3.1 + phase * 1.4 + 0.6) +
        0.06 * Math.sin(t * 5.3 + phase * 0.7);
      const pulse = Math.max(0.15, Math.min(1, breathe));
      // 上端をゆっくり左右に漂わせる（陽炎のような揺らぎ）
      const sway = Math.sin(t * 1.3 + phase) * laneW * 0.06;

      const yBot = hitY;
      const yTop = hitY - beamH;
      const xBotL = this.#perspX(l, laneW, W, yBot, hitY, persp, btnBot);
      const xBotR = this.#perspX(l + 1, laneW, W, yBot, hitY, persp, btnBot);
      const xTopL = this.#perspX(l, laneW, W, yTop, hitY, persp, btnBot) +
        sway;
      const xTopR = this.#perspX(l + 1, laneW, W, yTop, hitY, persp, btnBot) +
        sway;

      const grad = ctx.createLinearGradient(0, yBot, 0, yTop);
      grad.addColorStop(0, withAlpha(color, 0.55 * pulse));
      grad.addColorStop(0.5, withAlpha(color, 0.20 * pulse));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xBotL, yBot);
      ctx.lineTo(xBotR, yBot);
      ctx.lineTo(xTopR, yTop);
      ctx.lineTo(xTopL, yTop);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalCompositeOperation = prevComposite;
    ctx.globalAlpha = 1;
  }

  #drawHUD(ctx, W, H, o) {
    // スコア表示は #scoreDisplay（DOM）側に移動済み。ここでは combo のみ描画する。
    ctx.textBaseline = "top";
    ctx.shadowBlur = 0;
    const textColor = o.accentColor || o.uiColor;
    const d = o.dpr || 1;

    if (this.#combo >= 2) {
      ctx.font = this.#cachedComboFont;
      ctx.shadowColor = textColor;
      ctx.shadowBlur = o.glow ? 12 * d : 0;
      ctx.textAlign = "center";
      // topInset（navbar + #hudStack の高さ）より下に出す
      drawText(
        ctx,
        `${this.#combo} COMBO`,
        W / 2,
        Math.max(H * 0.14, (o.topInset || 0) + 40 * d),
        textColor,
      );
      ctx.shadowBlur = 0;
    }
  }
}
