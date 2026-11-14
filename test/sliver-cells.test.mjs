/**
 * 极短微格（N1）：**同一画面被切了两刀**产出的 <0.35 s 空格要删掉，真快剪一个都不许动。
 *
 * 为什么判据要两条（Δt 与指纹距离）：
 *   ① 只看 Δt —— 07-fastcut 每刀 0.29 s，会把整批真快剪删光；
 *   ② 只看距离 —— "两个镜头长得像但确实换了"会被误删。
 * 所以这里必有反例守着：真快剪（指纹差 180）必须原样保留。
 *
 * 构造数据不碰 ffmpeg：指纹就是 16×9 的常量块，画面在哪个帧号换由 valueAt 决定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { packPrints, unpackPrints } from '../src/storyboard/scan.js';
import {
  SLIVER_MAX_DIST, SLIVER_MAX_GAP_SEC, dropSliverCuts, resolveCuts, sliverEnabled,
} from '../src/storyboard/cuts.js';

const FP = 144;                                    // 16×9
const fp = (v) => Uint8Array.from({ length: FP }, () => v);
const printsOf = (frames, valueAt) => Array.from({ length: frames }, (_, i) => fp(valueAt(i)));

const scanStub = (cuts) => ({ cuts, stats: [], threshold: 80, degraded: null });

const opts = (cuts, extra = {}) => ({
  scan: scanStub(cuts),
  scanMode: 'mc',
  capGap: 0,
  strategy: 'compact',
  refineBursts: false,
  textOnly: false,
  precomputed: null,
  fps: 24,
  winStart: 0,
  winDur: 3,
  prints: null,
  means: null,
  ...extra,
});

/** 全程同一画面：两刀的左帧一模一样 → 距离 0 */
const STATIC = printsOf(72, () => 100);

/** 真快剪：每 7 帧（24 fps 下 0.2917 s）换一次画面，两块亮度差 180 */
const FASTCUT = printsOf(72, (i) => (Math.floor(i / 7) % 2 === 0 ? 20 : 200));

test('重复刀：Δt=0.26 s 且两刀左帧几乎一样 → 删掉后一刀，并留 trace', () => {
  const cuts = [{ t: 1.0, score: 0, kind: 'cut' }, { t: 1.26, score: 0, kind: 'cut' }];
  const out = resolveCuts(opts(cuts, { prints: STATIC, printFps: 24 }));
  assert.deepEqual(out.cuts.map((c) => c.t), [1], '后一刀（1.26）要消失，前一刀留着');
  assert.ok(
    out.trace.some((s) => s === 'drop-sliver:1.26:0.260'),
    `trace 要说清楚删了哪一刀、Δt 多少；实际：${out.trace.join(' | ')}`,
  );
});

test('真快剪（07-fastcut 同款：0.29 s 一刀、画面差很大）→ 一个都不删', () => {
  const cuts = [
    { t: 0.2916666666666667, score: 0, kind: 'cut' },
    { t: 0.5833333333333334, score: 0, kind: 'cut' },
    { t: 0.875, score: 0, kind: 'cut' },
  ];
  const out = resolveCuts(opts(cuts, { prints: FASTCUT, printFps: 24 }));
  assert.equal(out.cuts.length, 3, '0.29 s 的真快剪必须全部保留');
  assert.deepEqual(out.cuts.map((c) => c.t), cuts.map((c) => c.t), '时间戳一个都不许动');
  assert.equal(out.trace.filter((s) => s.startsWith('drop-sliver:')).length, 0);
});

test('DSH_NO_SLIVER=0 关掉开关后不删（回退路必须真的能用）', () => {
  const cuts = [{ t: 1.0, score: 0, kind: 'cut' }, { t: 1.26, score: 0, kind: 'cut' }];
  const before = process.env.DSH_NO_SLIVER;
  process.env.DSH_NO_SLIVER = '0';
  try {
    assert.equal(sliverEnabled(), false);
    const out = resolveCuts(opts(cuts, { prints: STATIC, printFps: 24 }));
    assert.deepEqual(out.cuts.map((c) => c.t), [1, 1.26], '开关关掉 → 一刀都不许少');
    assert.equal(out.trace.filter((s) => s.startsWith('drop-sliver:')).length, 0);
  } finally {
    if (before === undefined) delete process.env.DSH_NO_SLIVER;
    else process.env.DSH_NO_SLIVER = before;
  }
  assert.equal(sliverEnabled({ DSH_NO_SLIVER: '1' }), true, '默认开：只认 0/false/off/no 才是关');
});

test('间隔超过 0.35 s 的两刀不归这条规则管（哪怕画面一样）', () => {
  const cuts = [{ t: 1.0, score: 0, kind: 'cut' }, { t: 1.5, score: 0, kind: 'cut' }];
  const out = resolveCuts(opts(cuts, { prints: STATIC, printFps: 24, winDur: 3 }));
  assert.deepEqual(out.cuts.map((c) => c.t), [1, 1.5]);
});

test('转场切点不参与（中点左帧是过渡中间态，取舍归白闪那一阶段）', () => {
  const cuts = [
    { t: 1.0, score: 0, kind: 'transition', label: 'Fade', from: 0.95, to: 1.05 },
    { t: 1.26, score: 0, kind: 'cut' },
  ];
  const out = resolveCuts(opts(cuts, { prints: STATIC, printFps: 24 }));
  assert.equal(out.cuts.length, 2);
});

test('指纹帧率不同（24 fps 原生 vs 打包后 8 fps）判定必须一致', () => {
  // 缓存命中时 prints 是 packPrints 抽稀过的 8 fps 版；两条路的距离不能算出两个数
  const native = { prints: FASTCUT, printFps: 24 };
  const packedArr = unpackPrints(packPrints(FASTCUT, 24));
  const packed = { prints: packedArr, printFps: 8 };
  const cuts = [
    { t: 0.2916666666666667, score: 0, kind: 'cut' },
    { t: 0.5833333333333334, score: 0, kind: 'cut' },
    { t: 0.875, score: 0, kind: 'cut' },
  ];
  assert.equal(packedArr.length, 24, '24 fps/3 → 8 fps，抽稀后 24 帧');
  assert.equal(
    dropSliverCuts(cuts, native).cuts.length,
    dropSliverCuts(cuts, packed).cuts.length,
  );
  // 静态片两种帧率都必须删掉后一刀
  const dupe = [{ t: 1.0, score: 0, kind: 'cut' }, { t: 1.26, score: 0, kind: 'cut' }];
  const staticPacked = { prints: unpackPrints(packPrints(STATIC, 24)), printFps: 8 };
  assert.equal(dropSliverCuts(dupe, { prints: STATIC, printFps: 24 }).cuts.length, 1);
  assert.equal(dropSliverCuts(dupe, staticPacked).cuts.length, 1);
});

test('阈值本身：距离 12 是边界（≤ 删，> 留）', () => {
  assert.equal(SLIVER_MAX_GAP_SEC, 0.35);
  assert.equal(SLIVER_MAX_DIST, 12);
  const gray = (v) => Uint8Array.from({ length: FP }, () => v);
  const pair = [{ t: 1.0, score: 0, kind: 'cut' }, { t: 1.2, score: 0, kind: 'cut' }];
  const at = (v) => Array.from({ length: 72 }, () => gray(v));
  // 全程 100 → 左帧相同（距离 0）→ 删
  assert.equal(dropSliverCuts(pair, { prints: at(100), printFps: 24 }).cuts.length, 1);
  // 前 8 帧 100、之后 112：左帧差 12（等于阈值）→ 删
  const edge = printsOf(72, () => 100);
  for (let i = 22; i < 72; i += 1) edge[i] = gray(112);
  assert.equal(dropSliverCuts(pair, { prints: edge, printFps: 24 }).cuts.length, 1);
  // 差 13 → 留
  const over = printsOf(72, () => 100);
  for (let i = 22; i < 72; i += 1) over[i] = gray(113);
  assert.equal(dropSliverCuts(pair, { prints: over, printFps: 24 }).cuts.length, 2);
});

test('没有指纹 / 只有一刀时原样返回（不许因为缺数据就删刀）', () => {
  const cuts = [{ t: 1.0, score: 0, kind: 'cut' }, { t: 1.26, score: 0, kind: 'cut' }];
  assert.equal(resolveCuts(opts(cuts)).cuts.length, 2);
  assert.equal(dropSliverCuts(cuts, {}).cuts.length, 2);
  assert.equal(dropSliverCuts([{ t: 1, kind: 'cut' }], { prints: STATIC, printFps: 24 }).cuts.length, 1);
});
