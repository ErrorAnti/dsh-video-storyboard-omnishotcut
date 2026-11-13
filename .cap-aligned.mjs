#!/usr/bin/env node
/**
 * .cap-aligned.mjs — fillGaps「跨切点合并」改造的逐位取证脚本（不进仓库，只在 temp 里跑）。
 *
 * 用法（在 worktree 根目录）：
 *   node .cap-aligned.mjs --out before.json                 # 7 夹具 × {hsv, omnishotcut}
 *   node .cap-aligned.mjs --out after.json --check before.json
 *   node .cap-aligned.mjs --real --out before-120s.json     # 2 条 120 s 真片 × hsv
 *
 * 抓什么：
 *   - cuts.length + **每刀时间戳**（铁律 1：切点检测行为不许变）
 *   - plan.frames / plan.cells / plan.sheets / plan.tiers / plan.fill / plan.cell
 *   - 总 token（= sheets × imageTokens(canvas)，与 format.js 的 perImageList 同式）
 *
 * `cache:false`：两次都强制真扫，否则扫描分支根本没跑，对照白做。
 * 退出码：0 = 一致；1 = 有差异；2 = 跑挂了。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = presolve(HERE, '..', '..');            // temp/wt-aligned → tnv2-ab-20261112
const FIXTURES = process.env.FIXTURES_DIR ?? join(ROOT, 'fixtures');

// ---- osm 三件套：默认指向本仓库的 venv / 权重 / **worktree 里的**桥
process.env.DSH_OSM_PYTHON ??= join(ROOT, 'env', 'venv', 'Scripts', 'python.exe');
process.env.DSH_OSM_CKPT ??= join(ROOT, 'models', 'omnishotcut_ckpt.pth');
process.env.DSH_OSM_BRIDGE ??= join(HERE, 'src', 'storyboard', 'omnishotcut-bridge.py');
delete process.env.DSH_VIDEO_DETECTOR;              // 别让 ~/.dsh/video.json 覆盖显式传入的 detector

const { runStoryboard } = await import('./src/storyboard/pipeline.js');
const { imageTokens } = await import('./src/storyboard/tiers.js');

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = arg('out');
const CHECK = arg('check');
const REAL = argv.includes('--real');
if (!OUT) {
  console.error('usage: node .cap-aligned.mjs --out <file.json> [--check <base.json>] [--real]');
  process.exit(2);
}

/* ---------------------------------------------------------------- 夹具清单 */
const gt = JSON.parse(await readFile(join(FIXTURES, 'ground_truth.json'), 'utf8'));
const CLIPS = REAL
  ? ['real/sintel-120s.mp4', 'real/tears-of-steel-120s.mp4'].map((rel) => ({ rel, abs: join(FIXTURES, rel) }))
  : gt.clips.map((c) => ({ rel: c.file, abs: join(FIXTURES, c.file) }));
const DETECTORS = REAL ? ['hsv'] : ['hsv', 'omnishotcut'];
for (const c of CLIPS) {
  if (!existsSync(c.abs)) {
    console.error(`缺夹具：${c.abs}`);
    process.exit(2);
  }
}

/* ---------------------------------------------------------------- 抓一份 */
async function captureOne(c, detector) {
  const t0 = Date.now();
  const r = await runStoryboard({ input: c.abs, detector, cache: false, sourceHash: false, planOnly: true });
  const p = r.plan;
  const perImage = p.canvas ? imageTokens(p.canvas.width, p.canvas.height) : null;
  return {
    cuts: r.cuts.length,
    // 每刀时间戳（三位小数）+ 类型：铁律 1 的硬证据（`cuts` 元素是 `{t, score, type, ...}`）
    cutsTs: r.cuts.map((c) => +Number(c?.t ?? c).toFixed(3)),
    cutTypes: r.cuts.map((c) => c?.type ?? null),
    threshold: r.threshold,
    summaryFrames: r.summary?.frames ?? null,
    plan: {
      frames: p.frames,
      cells: p.cells,
      sheets: p.sheets,
      fill: p.fill,
      sheetFill: p.sheetFill,
      cell: p.cell,
      canvas: p.canvas,
      perImage,
      totalTokens: perImage != null ? perImage * p.sheets : null,
      tiers: p.tiers,
      rawTiers: p.rawTiers,
      strategy: p.strategy,
      trace: p.trace ?? null,
      auto: p.auto ? { chosen: p.auto.chosen, targetCap: p.auto.targetCap } : null,
      staticLongshot: p.staticLongshot ?? null,
    },
  };
}

/* ---------------------------------------------------------------- 深比较 */
function diff(a, b, path = '', out = []) {
  if (a === b) return out;
  const isObj = (v) => v && typeof v === 'object';
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: 长度 ${a.length} → ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) { out.push(`${path}.${k}: 新增 ${JSON.stringify(b[k])}`); continue; }
      if (!(k in b)) { out.push(`${path}.${k}: 丢失（原 ${JSON.stringify(a[k])}）`); continue; }
      diff(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}

/* ---------------------------------------------------------------- 跑 */
const result = {};
const rows = [];
for (const c of CLIPS) {
  for (const detector of DETECTORS) {
    const key = `${c.rel}::${detector}`;
    const t0 = Date.now();
    result[key] = await captureOne(c, detector);
    const row = result[key];
    rows.push({ key, detector, ...row });
    console.log(`  ${key.padEnd(40)} cuts=${String(row.cuts).padStart(3)} `
      + `frames=${String(row.plan.frames).padStart(3)} cells=${String(row.plan.cells).padStart(2)} `
      + `sheets=${row.plan.sheets} fill=${row.plan.fill} tok=${row.plan.totalTokens} `
      + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

await mkdir(dirname(presolve(OUT)), { recursive: true });
await writeFile(presolve(OUT), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`\n写入 ${presolve(OUT)}（${Object.keys(result).length} 行）`);

if (CHECK) {
  const base = JSON.parse(await readFile(presolve(CHECK), 'utf8'));
  // 铁律 1：cuts 数与每刀时间戳必须逐位相同 —— 单独先查，失败要一眼看见
  let cutDiffs = 0;
  console.log('\n=== 切点（铁律 1）===');
  for (const key of Object.keys(result)) {
    const a = base[key];
    const b = result[key];
    if (!a) { console.log(`  ${key}: 基线没有这一行`); cutDiffs += 1; continue; }
    const sameCnt = a.cuts === b.cuts;
    const sameTs = JSON.stringify(a.cutsTs) === JSON.stringify(b.cutsTs);
    if (!sameCnt || !sameTs) cutDiffs += 1;
    console.log(`  ${key.padEnd(40)} cuts ${a.cuts}→${b.cuts} ${sameCnt ? 'OK' : '**变了**'}`
      + ` | 时间戳 ${sameTs ? '0 差异' : '**变了**'}`);
  }
  const d = diff(base, result, '');
  console.log(`\n=== 全字段 diff：${d.length} 处 ===`);
  for (const line of d.slice(0, 400)) console.log(`  - ${line}`);
  if (d.length > 400) console.log(`  …（还有 ${d.length - 400} 行）`);
  if (cutDiffs > 0) process.exitCode = 1;
  assert.equal(cutDiffs, 0, '切点行为变了');
} else {
  console.log('\n（未传 --check：以上是基线快照）');
}
