/**
 * cuts.js — 切点链路的**唯一**编排点。
 *
 * 为什么单独一个文件：从 `scanShots` 的原始输出到"带标签的最终切点"之间有五个阶段，
 * 其中**前三个都拿 `cuts.length` 做准入判断**。它们必须按固定顺序跑，而这个顺序
 * 在代码里是隐式的 —— 谁把新阶段插错位置，就会悄悄抬高后面阶段的门槛。
 *
 * 2026-11-03 实测代价：把"abs 尖峰补刀"夹在 `scanShots` 内部合并，SHOT 27 段掉 3.2 个点
 * （一段的极静路径被整条跳过，一段的细扫结果被丢弃）。挪到链路末尾后回到 −0.3。
 *
 * 阶段表（顺序不可变）：
 *
 *   ┌ 0. 粗扫           scanShots 已给出 cuts（本文件不管）
 *   ├ 1. 极静素材补刀   perSec < 0.1 才进；会**替换**整个 cuts
 *   ├ 2. 爆点细扫       fine.length > coarse.length 才采纳；会**整窗替换**
 *   ├ 3. 丐中丐合并     cuts+1 > 56 才触发；**逐轮加大间隔**直到装得下
 *   ├ 3.5 极短微格      相邻两刀 ≤0.35s 且指纹距离 ≤12 → 删后一刀（`DSH_NO_SLIVER=0` 关）
 *   └ 4. 打标签         只加 type/evidence，**不增不删**
 *
 * **新增"加刀"或"删刀"的阶段，只能排在 3 之后、4 之前。**
 * 排在 1~3 之前会抬高它们的门槛；排在 4 之后会丢掉类型标签。
 *
 * 阶段 1 / 2 是给**逐帧分数曲线**补刀的（HSV 看得见曲线、看不见 0.35s 以下的刀）。
 * 换成就给了全量边界的外部后端（`detector: 'omnishotcut'`，见 pipeline.js）时，
 * 这两阶段再用只会把同一刀重复加上去，所以给它们各留一个开关：
 * `allowStillSpikes` / `allowRefineBursts`。**默认都是 true** —— 不传就是现在这套行为。
 */

import {
  PRINT_FPS, refineCutsByWindow, spikeCuts, suppressClose,
} from './scan.js';
import { tagCuts } from './flash.js';
import { STRATEGIES } from './tiers.js';

/** 极静素材的入口密度：低于这个值才认为"这段几乎不动"（PPT / 代码录屏 / 固定机位） */
export const STILL_PER_SEC = 0.1;
/** 极静素材补刀的分数地板：abs 口径 4 分够用，mc 口径必须高得多（刻度是占比） */
export const STILL_MIN_ABS = { abs: 4, mc: 25 };
/** 一屏最多几格（1/8 档 8×8=64，留余量取 56 —— 格子会浮动到 1/7，那时只有 49 格） */
export const ONE_SHEET_CAP = 56;

/**
 * 极静素材补刀该不该采纳。
 *
 * 这道门是 0.6.x 修的：早先只看"补出了更多刀就用"，结果 BBC 第一集 503 刀被换成
 * 8792 刀（精度掉到 6%）。现在要求两条同时成立：
 *   ① 确实补出了更多刀；
 *   ② 补刀后的密度仍在"静态素材"该有的范围内（≤0.3 刀/秒）——
 *      入口已经认定这是 PPT/代码录屏，它不可能每秒换 3 次画面。
 * 再加一条新颖度：补出来的刀里要有相当一部分**离任何粗扫刀都远**（>2s），
 * 否则是"同一刀的重复检测"，没有意义。
 */
export function shouldTakeSpikes({
  coarse = 0, spikes = 0, winDur = 0, spikeTimes = null, coarseTimes = null,
  novelGap = 2.0, minNovel = 0.4,
} = {}) {
  if (!(spikes > coarse)) return false;
  if (spikes / Math.max(1e-6, winDur) > 0.3) return false;
  if (Array.isArray(spikeTimes) && Array.isArray(coarseTimes) && spikeTimes.length >= 4) {
    let novel = 0;
    for (const t of spikeTimes) {
      let near = false;
      for (const c of coarseTimes) {
        if (Math.abs(t - c) <= novelGap) { near = true; break; }
      }
      if (!near) novel += 1;
    }
    if (novel / spikeTimes.length < minNovel) return false;
  }
  return true;
}

/**
 * 跑完整条切点链路。
 *
 * @param {object} o
 * @param {object} o.scan           `scanShots()` 的返回值
 * @param {string} o.scanMode       'mc' | 'abs'（决定极静补刀的分数地板）
 * @param {number} o.capGap         扫描期最小间隔（0 = 不合并）
 * @param {string} o.strategy       档位名（丐中丐要读 fitOneSheet）
 * @param {boolean} o.refineBursts  是否跑爆点细扫
 * @param {boolean} [o.allowStillSpikes]   阶段 1 的开关（默认 true，外部检测器要求关掉）
 * @param {boolean} [o.allowRefineBursts]  阶段 2 的开关（默认 true，外部检测器要求关掉）
 * @param {boolean} o.textOnly      纯文本模式：跳过所有图像相关的阶段
 * @param {boolean} o.precomputed   复用已有扫描结果：**原样返回**，一个阶段都不跑
 * @param {number} o.fps
 * @param {number} o.winStart       窗口起点（秒）
 * @param {number} o.winDur         窗口长度（秒）
 * @param {Array}  [o.prints]       逐帧指纹（打标签用）
 * @param {Array}  [o.means]        逐帧亮度均值（打标签用）
 * @param {number} [o.printFps]     指纹自己的帧率（缓存命中时是抽稀后的 8 fps）
 * @returns {{cuts: Array, refinedBursts: Array, trace: string[]}}
 */
/**
 * **多长的转场才可能是"真换镜头"**：超过这个宽度的 Fade 一律不删。
 *
 * 判据收紧的原因（2026-11-13 自审）：原规则只看「模型说是转场 + 亮度证据像闪光」，
 * 于是一段 1 s 的**真·白闪转场**（闪完画面换了）如果 `nv` 算得偏小也会被删掉。
 * 实测我们的样本里那个误报是 **0.083 s** 的 Fade —— 闪光都是瞬时的。
 * 所以加一条宽度上限：只有比它短的才允许删，长转场保留（宁可多一格，不许丢镜头）。
 */
export const FLASH_TRANSITION_MAX_SEC = 0.25;

/** 该切点是不是"短到可以判定为闪光"的转场。缺区间信息时按旧行为（可删）。 */
export function isFlashTransition(cut) {
  if (cut?.type !== 'flash' || cut?.kind !== 'transition') return false;
  const a = Number(cut.from);
  const b = Number(cut.to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return (b - a) <= FLASH_TRANSITION_MAX_SEC;
}

/**
 * 极短微格：**同一画面被切了两刀**（过分割），不许产出 <0.35 s 的格子。
 *
 * 为什么两条判据都要：只看 Δt 会把真快剪（07-fastcut 每刀 0.29 s）整批删光；
 * 只看距离会把"两镜头长得像但确实换了"删掉。Δt 管"近"，指纹距离管"是不是同一画面"。
 *
 * 距离口径：两刀**各自左侧一帧**的 16×9 灰度缩略图平均绝对差（0–255）。左帧落在
 * "被这一刀结束的那个镜头"里，所以重复刀的两帧必然同画面（≈0–10），真快剪的两帧
 * 必然分属相邻两个镜头（实测 ≥16.6）。12 是实测间隙（8.9 … 16.6）的几何中点。
 *
 * ⚠️ 指纹可能是**打包过的 8 fps 版**（缓存命中）也可能是原生 fps（缓存未命中），
 * 所以下标先归一到 `PRINT_FPS` 网格再取帧 —— 否则同一段视频两次跑的距离不同。
 */
export const SLIVER_MAX_GAP_SEC = 0.35;
export const SLIVER_MAX_DIST = 12;

/** 开关：默认开；`DSH_NO_SLIVER=0 / false / off / no` 关掉（留一条回退路） */
export function sliverEnabled(env = process.env) {
  const v = String(env?.DSH_NO_SLIVER ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 删掉"同一画面上的第二刀"。
 *
 * 保留**前一刀**（先到的边界才是镜头真正开始的地方）；`kind==='transition'` 一律不参与 ——
 * 转场中点的左帧是过渡中间态，不代表任何镜头，且它的取舍归第 5 阶段管，这里不许抢。
 *
 * @param {Array} cuts
 * @param {{prints?: Uint8Array[], printFps?: number}} o
 * @returns {{cuts: Array, dropped: Array<{t:number, dt:number, d:number}>}}
 */
export function dropSliverCuts(cuts, { prints = null, printFps = 0 } = {}) {
  const list = Array.isArray(cuts) ? cuts.filter((c) => c && Number.isFinite(Number(c.t))) : [];
  const n = Array.isArray(prints) ? prints.length : 0;
  const fps = Number(printFps) > 0 ? Number(printFps) : 0;
  if (list.length < 2 || n < 2 || fps <= 0) return { cuts: Array.isArray(cuts) ? cuts : [], dropped: [] };

  const step = Math.max(1, Math.round(fps / PRINT_FPS));   // 统一到 PRINT_FPS 网格（见上面注释）
  const at = (i) => prints[Math.min(n - 1, Math.max(0, i))];
  /** 该时刻**左侧**那一帧在指纹数组里的下标 */
  const left = (t) => Math.round((Number(t) * fps) / step) * step - step;
  const dist = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };

  const out = [];
  const dropped = [];
  for (const c of list) {
    const prev = out[out.length - 1];
    if (prev && prev.kind !== 'transition' && c.kind !== 'transition') {
      const dt = Number(c.t) - Number(prev.t);
      if (dt > 0 && dt <= SLIVER_MAX_GAP_SEC) {
        const d = dist(at(left(prev.t)), at(left(c.t)));
        if (d <= SLIVER_MAX_DIST) {
          dropped.push({ t: Number(c.t), dt, d: +d.toFixed(1) });
          continue;
        }
      }
    }
    out.push(c);
  }
  return { cuts: out, dropped };
}

export function resolveCuts({
  scan, scanMode = 'mc', capGap = 0, strategy, refineBursts = true,
  allowStillSpikes = true, allowRefineBursts = true,
  textOnly = false, precomputed = null, fps, winStart, winDur,
  prints = null, means = null, printFps = null, scoresPack = null,
}) {
  const trace = [];
  let cuts = scan.cuts ?? [];
  // 复用缓存时不做任何变换：那些阶段跑过一次了，重跑只会因为 stats 缺失而行为不同
  if (precomputed) return { cuts, refinedBursts: [], trace };

  // ---- 1. 极静素材补刀：绝对阈值会漏掉"只改了几个像素"的翻页
  if (allowStillSpikes && (scan.stats?.length ?? 0) > 20) {
    const perSec = cuts.length / Math.max(1, winDur);
    if (perSec < STILL_PER_SEC) {
      const minAbs = STILL_MIN_ABS[scanMode] ?? STILL_MIN_ABS.abs;
      const spikes = suppressClose(spikeCuts(scan.stats, { k: 4, minAbs, halfWindow: 12 }), capGap);
      if (shouldTakeSpikes({
        coarse: cuts.length, spikes: spikes.length, winDur,
        spikeTimes: spikes.map((c) => c.t), coarseTimes: cuts.map((c) => c.t),
      })) {
        trace.push(`still:${cuts.length}->${spikes.length}`);
        cuts = spikes;
      }
    }
  }

  // ---- 2. 爆点细扫：粗扫看不见 0.35s 以下的刀
  let refinedBursts = [];
  if (refineBursts && allowRefineBursts && !textOnly) {
    const r = refineCutsByWindow({
      stats: scan.stats, coarseCuts: cuts, fps, winStart, winDur,
      coarseThreshold: scan.threshold ?? 0,
    });
    cuts = r.cuts;
    refinedBursts = r.refined;
    for (const x of r.refined) trace.push(`refine:${x.from}-${x.to}s ${x.coarse}->${x.fine}`);
  }

  // ---- 3. 丐中丐档：自适应加大最小间隔，直到整段能装进一张图
  if (STRATEGIES[strategy]?.fitOneSheet && cuts.length + 1 > ONE_SHEET_CAP) {
    let gap = capGap > 0 ? capGap : 0.2;
    let fitted = suppressClose(cuts, gap);
    let rounds = 0;
    while (fitted.length + 1 > ONE_SHEET_CAP && gap < 120 && rounds < 60) {
      gap *= 1.3;
      fitted = suppressClose(cuts, gap);
      rounds += 1;
    }
    if (fitted.length < cuts.length) {
      trace.push(`merge:${cuts.length}->${fitted.length}@${gap.toFixed(1)}s`);
      cuts = fitted;
    }
  }

  // ---- 3.5 极短微格：同一画面被切了两刀 → 删后一刀（阶段 3 之后、4 之前，见文件头）
  if (!textOnly && Array.isArray(prints) && prints.length && sliverEnabled()) {
    const sliver = dropSliverCuts(cuts, { prints, printFps });
    if (sliver.dropped.length) {
      cuts = sliver.cuts;
      for (const d of sliver.dropped) trace.push(`drop-sliver:${d.t}:${d.dt.toFixed(3)}`);
    }
  }

  // ---- 4. 打标签：**一个都不删**（删掉误检会让这段在插件眼里变成"完全静止"）
  if (!textOnly && Array.isArray(prints) && prints.length) {
    // ⚠️ 指纹可能是**打包过的低帧率版本**（缓存命中时 `packPrints` 把 24fps 压到 8fps）。
    // 用真实 fps 去算下标会整体错位：evidence 变 null 或乱判，白闪剔除随之失效。
    // 所以这里用指纹自己的帧率；`scores` 是按真实帧存的，帧率不一致时不喂给 tagCuts。
    const tagFps = Number(printFps) > 0 ? Number(printFps) : fps;
    const sameRate = !(Number(printFps) > 0) || Math.abs(Number(printFps) - Number(fps)) < 1e-6;
    // 分数序列**永远按真实帧率**给（stats 在缓存里是全量的），指纹用打印帧率 —— 两者别混。
    cuts = tagCuts(cuts, {
      prints,
      means,
      fps: tagFps,
      scoreFps: fps,
      scores: scan.stats?.map((s) => s.score),
    });
  }

  // ---- 5. 只删「转场型白闪」：模型说是转场，而亮度证据说是"亮了一下又回来"
  //
  // 这一段**必须排在 4 之后**：它读的就是 4 打出来的 `type` 和转场后端给的 `kind`。
  // 判据是两条 AND，缺一不可：
  //   ① `kind === 'transition'` —— 只有转场后端（OmniShotCut）会产出这种切点；
  //      纯 HSV 路径没有这个字段，因此**行为逐位不变**（这是不回归的关键）。
  //   ② `type === 'flash'` —— flash.js 的 pulse/nv/corr 三条件已经成立：
  //      亮度冲高过、又回到原样、结构没变。白闪**转场**的 nv 很大，不会被误伤。
  // 为什么只在这一种组合下删：删除会丢掉"这里在动"的信息（见 flash.js 头注释），
  // 而"转场型白闪"是个例外 —— 它既不是新镜头，也不是连续运动，留着只会多出一格。

  if (!textOnly && cuts.some((c) => isFlashTransition(c))) {
    const before = cuts.length;
    cuts = cuts.filter((c) => !isFlashTransition(c));
    trace.push(`drop-flash-transition:${before}->${cuts.length}`);
  }

  return { cuts, refinedBursts, trace };
}
