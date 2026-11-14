/**
 * fill-hole.test.mjs — **格子阵不许留空位**（G-F 臂：`DSH_FILL_HOLE=1`）。
 *
 * 病（G-L 实测，2026-11-15，见 docs/decisions/0006）：
 * 3×3 的阵只填 8 格（3+2+3）时，模型**按阵报数** —— 20 次里 9 次答 9 格（真值 8）。
 * 满阵（9 格）时同一模型 20/20 全对（9 格板三处独立验证）。
 * 反证：档位数组 `{2:2,3:7}` → `{3:9}` 时板 PNG 的 sha256 **逐位相同** ——
 * 档位数值够不到模型的眼睛，真正起作用的是"阵里有没有洞"。
 *
 * 修法：某张图 fill < 0.95 且 `rows*cols - cells == 1` 时，把这张图的档位整体 +1、
 * 在**段内部**多切一帧把阵补满；补不上就什么都不做。开关默认关（关掉时行为与改动前逐位相同）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellGrid, fillHoleEnabled, runStoryboard } from '../src/storyboard/pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// 夹具在仓库里（plugin/../fixtures/clips）；worktree 里跑时用 DSH_FIXTURE_CLIPS 指过去
const CLIPS = process.env.DSH_FIXTURE_CLIPS
  ? resolve(process.env.DSH_FIXTURE_CLIPS)
  : join(HERE, '..', '..', 'fixtures', 'clips');
const FLASH = join(CLIPS, '04-flash.mp4');

const W = 924;
const H = 385;
/** 04-flash 实际渲染出来的格子：308×128 px（924/3 × 385/3）。 */
const cell = (x, y) => ({ x: (x * 308) / W, y: (y * 128) / H, w: 308 / W, h: 128 / H });

/* ----------------------------------------------------------- 纯函数 */

test('cellGrid：3+2+3 塞进 3×3 → 阵里空着 1 格', () => {
  const cells = [
    cell(0, 0), cell(1, 0), cell(2, 0),
    cell(0, 1), cell(1, 1),
    cell(0, 2), cell(1, 2), cell(2, 2),
  ];
  const g = cellGrid(cells, { width: W, height: H });
  assert.equal(g.n, 8);
  assert.equal(g.rows, 3);
  assert.equal(g.cols, 3);
  assert.equal(g.slots, 9);
  assert.equal(g.slots - g.n, 1, '这就是"只差一格"');
  assert.deepEqual(g.rowCounts, [3, 2, 3]);
});

test('cellGrid：3+3+3 满阵 → 一格不空', () => {
  const cells = [];
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) cells.push(cell(x, y));
  const g = cellGrid(cells, { width: W, height: H });
  assert.equal(g.n, 9);
  assert.equal(g.slots, 9);
  assert.equal(g.slots - g.n, 0, '满阵：洞 = 0（G-L 里 20/20 全对的就是这种板）');
});

test('cellGrid：2+2 两行铺满 → 不算洞', () => {
  const cells = [cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)];
  const g = cellGrid(cells, { width: W, height: H });
  assert.equal(g.rows, 2);
  assert.equal(g.cols, 2);
  assert.equal(g.n, 4);
  assert.equal(g.slots - g.n, 0);
});

test('cellGrid：空图不炸（0 张图 / 0 格）', () => {
  assert.deepEqual(cellGrid([], { width: W, height: H }), { n: 0, rows: 0, cols: 0, slots: 0, rowCounts: [] });
  assert.deepEqual(cellGrid(null, { width: W, height: H }), { n: 0, rows: 0, cols: 0, slots: 0, rowCounts: [] });
});

test('开关只认 DSH_FILL_HOLE=1（默认关）', () => {
  const prev = process.env.DSH_FILL_HOLE;
  try {
    delete process.env.DSH_FILL_HOLE;
    assert.equal(fillHoleEnabled(), false, '默认关：关掉时 PNG 必须与改动前逐位相同');
    process.env.DSH_FILL_HOLE = '1';
    assert.equal(fillHoleEnabled(), true);
    // 只认 '1'：写成 true/yes 之类不该偷偷打开
    for (const v of ['true', 'yes', '0', '']) {
      process.env.DSH_FILL_HOLE = v;
      assert.equal(fillHoleEnabled(), false, `DSH_FILL_HOLE=${v} 不该开`);
    }
  } finally {
    if (prev === undefined) delete process.env.DSH_FILL_HOLE; else process.env.DSH_FILL_HOLE = prev;
  }
});

/* --------------------------------------------------------------- e2e */

const e2eReady = existsSync(FLASH);

async function planOf() {
  const r = await runStoryboard({
    input: FLASH, planOnly: true, detector: 'hsv', strategy: 'auto', transcript: 'off',
  });
  return r.plan;
}

test('e2e: 04-flash 关着开关 → 8 格、trace 里没有 fill-hole（现版行为）', async (t) => {
  if (!e2eReady) return t.skip(`夹具不在：${FLASH}（可用 DSH_FIXTURE_CLIPS 指到 fixtures/clips）`);
  const prev = process.env.DSH_FILL_HOLE;
  try {
    delete process.env.DSH_FILL_HOLE;
    const p = await planOf();
    assert.equal(p.sheets, 1);
    assert.equal(p.cells, 8, '关掉开关时格数必须还是 8（否则就是偷偷改了默认行为）');
    assert.equal(p.fill, 88.9);
    assert.ok(!(p.trace ?? []).some((x) => String(x).startsWith('fill-hole')), '关着不许留痕');
  } finally {
    if (prev === undefined) delete process.env.DSH_FILL_HOLE; else process.env.DSH_FILL_HOLE = prev;
  }
});

test('e2e: 04-flash 打开开关 → 9 格满阵、张数不变、trace 留痕', async (t) => {
  if (!e2eReady) return t.skip(`夹具不在：${FLASH}（可用 DSH_FIXTURE_CLIPS 指到 fixtures/clips）`);
  const prev = process.env.DSH_FILL_HOLE;
  try {
    process.env.DSH_FILL_HOLE = '1';
    const p = await planOf();
    assert.equal(p.cells, 9, '3×3 的阵该被补满（8 → 9）');
    assert.equal(p.sheets, 1, '不许多开一张图');
    assert.ok((p.trace ?? []).includes('fill-hole:+1 cell=9 tier+1'),
      `trace 必须写明补了哪一格，实得 ${JSON.stringify(p.trace)}`);
    // 档位整体 +1：原来最低是 2 档，补完最低不能再有 2 档
    const tiers = Object.keys(p.tiers).map(Number);
    assert.ok(Math.min(...tiers) >= 3, `档位该整体 +1，实得 ${JSON.stringify(p.tiers)}`);
    // rawTiers 与格数对齐（补的刀是段内切，raw 也要多一份，否则清单少一格）
    const rawN = Object.values(p.rawTiers ?? {}).reduce((a, b) => a + b, 0);
    assert.equal(rawN, 9, `rawTiers 应覆盖 9 格，实得 ${rawN}`);
  } finally {
    if (prev === undefined) delete process.env.DSH_FILL_HOLE; else process.env.DSH_FILL_HOLE = prev;
  }
});
