/**
 * 切点分数补偿（P2）：OmniShotCut 只给边界、不给 0–255 曲线，`cut.score` 原本恒 0，
 * 导致 `cuts.js` 阶段 3 的「合并时保留分数更高的一刀」退化成「保留第一个」。
 *
 * 规则：用 HSV 曲线在切点 ±0.12 s 内的**峰值**填分数；窗口内没有采样就退到最近的一帧。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { fillCutsScore } = await import('../src/storyboard/omnishotcut.js');

const stats = [
  { t: 0.0, score: 1 },
  { t: 3.0, score: 12 },
  { t: 3.04, score: 97 },
  { t: 3.08, score: 40 },
  { t: 6.0, score: 33 },
  { t: 9.5, score: 88 },
];

test('取 ±0.12s 窗口内的峰值', () => {
  const out = fillCutsScore([{ t: 3.05, score: 0 }], stats);
  assert.equal(out[0].score, 97);
});

test('窗口内没有采样就退到最近一帧', () => {
  const out = fillCutsScore([{ t: 9.9, score: 0 }], stats);
  assert.equal(out[0].score, 88);
});

test('不动 kind / label / from / to，也不改输入数组', () => {
  const cuts = [{ t: 3.05, score: 0, kind: 'transition', label: 'Dissolve', from: 2, to: 4 }];
  const out = fillCutsScore(cuts, stats);
  assert.equal(cuts[0].score, 0, '输入不能被就地修改');
  assert.equal(out[0].kind, 'transition');
  assert.equal(out[0].label, 'Dissolve');
  assert.equal(out[0].from, 2);
});

test('没有曲线时原样返回', () => {
  const cuts = [{ t: 1, score: 0 }];
  assert.deepEqual(fillCutsScore(cuts, []), cuts);
  assert.deepEqual(fillCutsScore(cuts, null), cuts);
});
