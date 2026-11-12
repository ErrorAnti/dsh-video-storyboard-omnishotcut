/**
 * 转场型白闪（v2 · P1）：模型标成转场、亮度证据说是"闪一下又回来"的切点，要删掉。
 *
 * 为什么要单独一个文件：这是**唯一**允许删切点的地方（`flash.js` 的设计原则是
 * "只打标签不删"），所以判据必须极窄，且必须有反例守着：
 *   ① 只有 `kind==='transition'` 才可能被删 —— 纯 HSV 路径不产出这个字段，行为不变；
 *   ② `type` 必须是 `flash` —— 白闪**转场**（画面真的换了）的 nv 很大，不会命中；
 *   ③ 删除会留 `trace`，清单能解释"这里为什么少了一刀"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PULSE_MIN, NV_MAX, CORR_MIN } from '../src/storyboard/flash.js';

// resolveCuts 依赖 scan.js 的一堆导出，但本用例只走"已打标签的切点"这一段，
// 所以直接测它的行为契约：用最小的 scan 桩 + 预先标好 type 的切点。
const { resolveCuts } = await import('../src/storyboard/cuts.js');

const scanStub = (cuts) => ({
  cuts, stats: [], threshold: 80, degraded: null,
});

const baseOpts = (cuts) => ({
  scan: scanStub(cuts),
  scanMode: 'mc',
  capGap: 0,
  strategy: 'compact',
  refineBursts: false,
  textOnly: false,
  precomputed: null,
  fps: 24,
  winStart: 0,
  winDur: 13,
  prints: null,          // 没有指纹 → 跳过打标签，直接验证第 5 阶段
  means: null,
});

test('转场型白闪被删掉，并留 trace', () => {
  const cuts = [
    { t: 1.0, score: 0, kind: 'cut' },
    { t: 7.5, score: 0, kind: 'transition', label: 'Fade', type: 'flash' },
    { t: 11.0, score: 0, kind: 'cut' },
  ];
  const out = resolveCuts(baseOpts(cuts));
  assert.deepEqual(out.cuts.map((c) => c.t), [1, 11]);
  assert.ok(out.trace.some((s) => s.startsWith('drop-flash-transition:3->2')), 'trace 要说清楚删了什么');
});

test('硬切上的 flash 标签不删（那是 HSV 路径，删了会让这段变成"完全静止"）', () => {
  const cuts = [
    { t: 1.0, score: 0, kind: 'cut', type: 'flash' },
    { t: 11.0, score: 0, kind: 'cut' },
  ];
  const out = resolveCuts(baseOpts(cuts));
  assert.equal(out.cuts.length, 2);
});

test('转场型白闪「转场」（type=white）不删', () => {
  const cuts = [
    { t: 1.0, score: 0, kind: 'transition', label: 'Fade', type: 'white' },
    { t: 11.0, score: 0, kind: 'cut' },
  ];
  const out = resolveCuts(baseOpts(cuts));
  assert.equal(out.cuts.length, 2);
});

test('没有任何转场型白闪时，cuts 原样返回（顺序与对象都不变）', () => {
  const cuts = [
    { t: 3.0, score: 0, kind: 'cut' },
    { t: 6.0, score: 0, kind: 'transition', label: 'Dissolve', type: 'dissolve' },
  ];
  const out = resolveCuts(baseOpts(cuts));
  assert.deepEqual(out.cuts, cuts);
});

test('判据阈值与 flash.js 同源（改动必须同步）', () => {
  // 这三个常量的语义写在 flash.js 头注释里；这里只是把"谁在用"钉住
  assert.equal(typeof PULSE_MIN, 'number');
  assert.equal(typeof NV_MAX, 'number');
  assert.equal(typeof CORR_MIN, 'number');
});
