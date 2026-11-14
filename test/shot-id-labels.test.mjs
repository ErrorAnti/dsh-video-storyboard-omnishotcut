/**
 * shot-id-labels.test.mjs — 「图上编号 = 格」vs「图上编号 = 镜头」。
 *
 * 2026-11-15：G1 单变量臂（只改图上烧的编号语义）。三个断言：
 *   1. `shotIdsFor` 只按**切点**开新号：镜头内部补刀出来的两格共用一个号（按 `via` 数会错，这里钉住）
 *   2. `DSH_SHOT_ID_LABELS` 关着就是关着（默认值、'0'/'false'/'off'/'no' 全算关）
 *   3. `composePacked` 认 `r.shotId`；没给就退回 `r.index` —— 老路径的像素不变
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { shotIdLabelsEnabled, shotIdsFor } from '../src/storyboard/pipeline.js';
import { composePacked } from '../src/storyboard/sheet.js';

/* ------------------------------------------------------------ 镜头号的判据 */

test('shotIdsFor: 切点开新号，镜头内部的补刀共用同一个号', () => {
  // 8 个镜头、9 个格子：第 1 个镜头被 fillGaps 补刀成 0–1.05 / 1.05–3 两格
  const segs = [
    { from: 0, to: 1.05 }, { from: 1.05, to: 3 },
    { from: 3, to: 6 }, { from: 6, to: 9 }, { from: 9, to: 12 },
    { from: 12, to: 15 }, { from: 15, to: 18 }, { from: 18, to: 21 }, { from: 21, to: 24 },
  ];
  assert.deepEqual(shotIdsFor(segs, [3, 6, 9, 12, 15, 18, 21]), [1, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('shotIdsFor: 第一格不在切点上也必须是第 1 个镜头', () => {
  // 窗口从镜头中间开始：from=4.2 不是任何切点
  assert.deepEqual(shotIdsFor([{ from: 4.2, to: 6 }, { from: 6, to: 9 }], [3, 6, 9]), [1, 2]);
});

test('shotIdsFor: 一个切点都没有 = 一个镜头（长镜头被切成 n 格仍是 n 个 1）', () => {
  const segs = Array.from({ length: 4 }, (_, i) => ({ from: i * 2, to: (i + 1) * 2 }));
  assert.deepEqual(shotIdsFor(segs, []), [1, 1, 1, 1]);
});

test('shotIdsFor: 切点带浮点噪声仍算同一条边界（1e-3 容差）', () => {
  assert.deepEqual(shotIdsFor([{ from: 0, to: 3 }, { from: 3.0004, to: 6 }], [3]), [1, 2]);
});

test('shotIdsFor: 空输入不炸', () => {
  assert.deepEqual(shotIdsFor([], [1, 2]), []);
  assert.deepEqual(shotIdsFor([{ from: 0, to: 1 }], null), [1]);
});

/* ------------------------------------------------------------ 环境变量闸门 */

test("shotIdLabelsEnabled: 默认关，'0'/'false'/'off'/'no' 都算关", () => {
  const keep = process.env.DSH_SHOT_ID_LABELS;
  try {
    delete process.env.DSH_SHOT_ID_LABELS;
    assert.equal(shotIdLabelsEnabled(), false);
    for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
      process.env.DSH_SHOT_ID_LABELS = v;
      assert.equal(shotIdLabelsEnabled(), false, `${JSON.stringify(v)} 应当是关`);
    }
    for (const v of ['1', 'true', 'on', 'yes']) {
      process.env.DSH_SHOT_ID_LABELS = v;
      assert.equal(shotIdLabelsEnabled(), true, `${JSON.stringify(v)} 应当是开`);
    }
  } finally {
    if (keep === undefined) delete process.env.DSH_SHOT_ID_LABELS;
    else process.env.DSH_SHOT_ID_LABELS = keep;
  }
});

/* ------------------------------------------------------------ 拼图上的编号 */

const W = 80;
const H = 20;
const frame = () => ({ buffer: Buffer.alloc(40 * H * 3, 90), w: 40, h: H });
const twoCells = (second) => [
  { px: 0, py: 0, pw: 40, ph: H, index: 1 },
  { px: 40, py: 0, pw: 40, ph: H, ...second },
];

test('composePacked: 带 shotId 的格子烧的是镜头号（与同号 index 逐位相同）', () => {
  const withShot = composePacked({
    frames: [frame(), frame()], rects: twoCells({ index: 2, shotId: 1 }), width: W, height: H,
  });
  const plain = composePacked({
    frames: [frame(), frame()], rects: twoCells({ index: 1 }), width: W, height: H,
  });
  assert.equal(withShot.buffer.compare(plain.buffer), 0, 'shotId=1 必须和 index=1 烧出同一张图');
});

test('composePacked: 不给 shotId 时仍按 index 烧（老路径不变）', () => {
  const a = composePacked({
    frames: [frame(), frame()], rects: twoCells({ index: 7 }), width: W, height: H,
  });
  const b = composePacked({
    frames: [frame(), frame()], rects: twoCells({ index: 8 }), width: W, height: H,
  });
  assert.notEqual(a.buffer.compare(b.buffer), 0, '7 和 8 不该烧出同一张图');
});
