/**
 * fill-gaps-alignment.test.mjs — `fillGaps` **不许把相邻镜头合并成一格**（跨切点合并）。
 *
 * 病：`fillGaps` 的 ① 减帧 / ② 时间均分都是把 `[lo, hi]` 按时间**重新等分**，段边界（= 切点）
 * 整个丢掉 —— 一条 6 镜头 18 s 的素材因此变 4 格、每格跨 1~2 个切点，2 个镜头一帧都没出现。
 * 图像 token 里没有"格子边界"，所以跨刀格子对模型是**不可见的错误**。
 *
 * `fillGaps` 是 `runStoryboard` 里的闭包、调不到；所以判据抽成了模块级纯函数
 * （`CELL_CAP` / `hasCutInBin` / `hasTransitionInBin` / `shouldRepartition`），
 * 这里对着它们 + `framesFromBounds` 造出的**真实分段表**做断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CELL_CAP, hasCutInBin, hasTransitionInBin, shouldRepartition,
} from '../src/storyboard/pipeline.js';
import { framesFromBounds } from '../src/storyboard/tiers.js';

/** 这一格覆盖的时间边界：第一段的 from + 每一段的 to（老代码均分后会换成另一套边界）。 */
function boundsOf(segs, seqs) {
  const list = [...seqs].sort((a, b) => a - b);
  return [segs[list[0]].from, ...list.map((i) => segs[i].to)];
}

test('含切点的 bin 不会被重排：格子边界仍等于段边界', () => {
  // 6 镜头 18 s，切点故意**不等距** —— 均分出来的边界一定和切点对不上（丢的就是这部分）。
  const cuts = [1.2, 2, 7.5, 8.1, 16];
  const segs = framesFromBounds({ duration: 18, cuts });
  assert.equal(segs.length, 6);
  assert.deepEqual(segs.map((s) => s.via), ['start', 'cut', 'cut', 'cut', 'cut', 'cut']);

  const seqs = [0, 1, 2, 3, 4, 5];
  assert.equal(hasCutInBin(segs, seqs), true, '区间内部有 via==="cut" 的段');
  assert.equal(shouldRepartition(segs, seqs), false, '6 格 + 内含切点 → 不许减帧/均分');

  // 保住的边界：格子边界仍等于段边界，且每个切点都还在
  assert.deepEqual(boundsOf(segs, seqs), [0, ...cuts, 18]);

  // 对照：老代码第 ① 招会把 [0,18] 均分 4 格（边界 0/4.5/9/13.5/18）—— 切点全被吃掉
  const span = 18 / 4;
  const merged = Array.from({ length: 5 }, (_, j) => +(span * j).toFixed(3));
  assert.deepEqual(merged, [0, 4.5, 9, 13.5, 18]);
  for (const c of cuts) assert.ok(!merged.includes(c), `切点 ${c} 会被合并吃掉（这正是要禁掉的）`);
});

test('单板 >12 格才允许合并（CELL_CAP 上限生效）', () => {
  assert.equal(CELL_CAP, 12, '单板上限是 12 格');
  // 12 刀 → 13 段，够到上限两侧
  const cuts = Array.from({ length: 12 }, (_, i) => +(1 + i * 1.5).toFixed(3));
  const segs = framesFromBounds({ duration: 19, cuts });
  assert.equal(segs.length, 13);

  const twelve = [...Array(12).keys()];        // 0..11
  const thirteen = [...Array(13).keys()];      // 0..12
  assert.equal(hasCutInBin(segs, twelve), true);
  assert.equal(shouldRepartition(segs, twelve), false, '12 格还在上限内 → 不许合并');
  assert.equal(shouldRepartition(segs, thirteen), true, '13 格 > CELL_CAP → 允许合并（否则快剪无限膨胀）');
});

test('不含切点的 bin 行为与改前一致（回归）', () => {
  // 只有积分假切点（via:'mark'）的窗口：老代码照常减帧/均分，新判据必须一律放行
  const segs = framesFromBounds({ duration: 40, marks: [10, 20, 30] });
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.map((s) => s.via), ['start', 'mark', 'mark', 'mark']);
  for (const n of [1, 2, 3, 4]) {
    const seqs = [...Array(n).keys()];
    assert.equal(hasCutInBin(segs, seqs), false);
    assert.equal(shouldRepartition(segs, seqs), true, `${n} 格：没有切点 → 行为与改前一致`);
  }
  // 上限调小也不影响"无切点就放行"
  assert.equal(shouldRepartition(segs, [0, 1, 2, 3], 4), true);
});

test('转场段保护仍然生效（补位不许动转场）', () => {
  // 5~6 s 是一段转场：两个边界都成为段边界，于是它自己占一段（via='transition'）
  const segs = framesFromBounds({
    duration: 12, marks: [4, 8], transitions: [{ from: 5, to: 6 }],
  });
  assert.deepEqual(segs.map((s) => s.via), ['start', 'mark', 'transition', 'start', 'mark']);

  assert.equal(hasTransitionInBin(segs, [1, 2]), true);
  assert.equal(hasTransitionInBin(segs, [0, 1]), false);
  // 这一格没有切点 → 新判据是**放行**的；挡住补位的仍然是那条转场保护（它没被新规则架空）
  assert.equal(hasCutInBin(segs, [0, 1]), false);
  assert.equal(shouldRepartition(segs, [0, 1]), true);
});

test('第一段 via==="cut" 只是格的左边界，不算跨切点', () => {
  const segs = [
    { from: 2, to: 5, t: 3.5, cut: true, via: 'cut' },
    { from: 5, to: 9, t: 7, cut: true, via: 'cut' },
  ];
  assert.equal(hasCutInBin(segs, [0]), false, '只有第一段是 cut → 不跨');
  assert.equal(shouldRepartition(segs, [0]), true);
  assert.equal(hasCutInBin(segs, [0, 1]), true, '第二段也是 cut → 跨了切点');
  assert.equal(shouldRepartition(segs, [0, 1]), false);
});
