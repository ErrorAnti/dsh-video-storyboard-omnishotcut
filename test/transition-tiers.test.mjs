/**
 * 转场段（v2）：OmniShotCut 给出 `[from,to]` 之后，
 *   ① 这段必须**自己占一段**（不是被折叠成一个点），标签是 `via:'transition'`；
 *   ② 它的档位至少 1/4（`TRANSITION_TIER`），但周围更细的密度不许被它抬高；
 *   ③ 落在转场**内部**的中点切点必须先被过滤掉，否则会把这段劈成两半、标签永远打不上。
 *
 * 第 ③ 条是实测踩出来的：pipeline 里 `segCuts` 就是干这个的；这里用同样的规则复现一遍，
 * 保证规则本身不会在重构时被丢掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTransitionBoost, framesFromBounds, TRANSITION_TIER,
} from '../src/storyboard/tiers.js';

const TRANSITIONS = [
  { from: 2.042, to: 3.0, label: 'Dissolve' },
  { from: 4.042, to: 5.0, label: 'Dissolve' },
];
const CUTS = [2.521, 4.521]; // 两个都落在转场内部

/** 与 pipeline 里 `segCuts` 同规则：丢掉落在转场内部的中点切点 */
const segCutsOf = (cuts, transitions) => cuts.filter(
  (t) => !transitions.some((tr) => t > tr.from + 1e-6 && t < tr.to - 1e-6),
);

test('转场区间自己占一段，并带 via=transition', () => {
  const segs = framesFromBounds({
    duration: 6, start: 0, cuts: segCutsOf(CUTS, TRANSITIONS), marks: [], transitions: TRANSITIONS,
  });
  const tr = segs.filter((s) => s.via === 'transition');
  assert.equal(tr.length, 2, '两段转场应该各自成段');
  assert.deepEqual(tr.map((s) => [+s.from.toFixed(3), +s.to.toFixed(3)]), [[2.042, 3], [4.042, 5]]);
  // 前后镜头仍然是普通段
  assert.equal(segs[0].via, 'start');
});

test('不过滤内部切点会把转场劈成两半（这就是 segCuts 存在的原因）', () => {
  const segs = framesFromBounds({
    duration: 6, start: 0, cuts: CUTS, marks: [], transitions: TRANSITIONS,
  });
  assert.equal(segs.some((s) => s.via === 'transition'), false);
});

test('转场段档位至少 1/4，且不降低已有的更细档位', () => {
  const segs = [
    { via: 'start' }, { via: 'transition' }, { via: 'mark' }, { via: 'transition' },
  ];
  const tiers = [2, 2, 2, 7];
  assert.deepEqual(applyTransitionBoost(tiers, segs), [2, TRANSITION_TIER, 2, 7]);
});

test('补位帧（tier 0）不参与转场加成', () => {
  const segs = [{ via: 'transition' }, { via: 'transition' }];
  assert.deepEqual(applyTransitionBoost([0, 3], segs), [0, TRANSITION_TIER]);
});

test('没有转场时行为与原来逐位一致', () => {
  const base = framesFromBounds({ duration: 10, start: 0, cuts: [3, 6], marks: [4.5] });
  const withEmpty = framesFromBounds({
    duration: 10, start: 0, cuts: [3, 6], marks: [4.5], transitions: [],
  });
  assert.deepEqual(withEmpty, base);
});
