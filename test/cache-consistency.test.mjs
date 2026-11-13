/**
 * cache-consistency.test.mjs — 「同一进程里连跑两次，结果必须完全一致」的常驻回归。
 *
 * 为什么必须有这个文件：这是**最容易静默复发**的一类 bug，复发时清单看起来一切正常。
 * 历史事故（缓存版本 32 之前，真实踩过）：
 *
 *   缓存条目里的逐帧指纹是 `packPrints` 抽稀过的 **8 fps** 版本，而 `stats` 是按真实帧
 *   （24 fps）存的。第二次跑命中缓存后，`tagCuts` 仍然拿 24 fps 去算下标 —— 整条时间轴
 *   错位，于是**同一片第一次 5 刀、第二次 6 刀**，标签还从 `hardcut` 变成 `dissolve`。
 *   修法有两半（缺一不可）：`cuts.js` 用**指纹自己的帧率**（`printFps`）打标签；
 *   `pipeline.js` 命中时从缓存条目取回 `means`，并把分数曲线按指纹帧率压一份 `scores`。
 *
 * 所以这个文件守三件事：
 *   ① 行为：真跑两遍（miss → hit），`cuts` / 标签 / 排布逐字段相等，且第二次确实命中缓存；
 *   ② 覆盖：hsv 与 omnishotcut 两个后端都跑一遍（osm 环境不全时**跳过而不是失败**）；
 *   ③ 反例：读源码 + 正则把上面那两半钉住 —— 防止有人"顺手"把 `printFps` 改回调用方 `fps`。
 *
 * 速度：hsv 用 `04-flash.mp4`（18 s，7 刀，含 2 个 flash 标签，正好走到 conc/scores 那条路），
 * osm 用更短的 `06-whip.mp4`。两端在**同一进程**里连跑，第二次命中缓存只要 0.2–0.3 s。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'storyboard');
// 夹具在仓库外一层（plugin/../fixtures/clips）；也可以用 DSH_FIXTURE_CLIPS 指到别处
const CLIPS = process.env.DSH_FIXTURE_CLIPS
  ? resolve(process.env.DSH_FIXTURE_CLIPS)
  : join(HERE, '..', '..', 'fixtures', 'clips');
const FLASH = join(CLIPS, '04-flash.mp4');   // 18.08 s / 24 fps / 7 刀（含 flash）
const WHIP = join(CLIPS, '06-whip.mp4');     // 15.00 s / 24 fps / 3 刀（osm 用，跑得更快）

const { runStoryboard } = await import('../src/storyboard/pipeline.js');
// 缓存里指纹被抽稀到的帧率：整个事故的根源就是"它和 info.fps 不一样"
const { PRINT_FPS } = await import('../src/storyboard/scan.js');

/**
 * 缓存目录必须换到临时目录：`cacheDir()` 每次调用都读 `process.env`，
 * 所以只要在**调用前**改环境变量就够了（不需要提前 import）。
 * 媒体目录也一起换 —— 首次 miss 之后会跑 `pruneStorage()`，它能删媒体文件，
 * 不隔离就会动到真实缓存。
 */
async function withTempCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-consistency-'));
  const saved = {
    cache: process.env.DSH_VIDEO_CACHE_DIR,
    media: process.env.DSH_VIDEO_MEDIA_DIR,
  };
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  process.env.DSH_VIDEO_MEDIA_DIR = join(dir, 'media');
  try {
    return await fn(dir);
  } finally {
    for (const [k, name] of [['cache', 'DSH_VIDEO_CACHE_DIR'], ['media', 'DSH_VIDEO_MEDIA_DIR']]) {
      if (saved[k] === undefined) delete process.env[name];
      else process.env[name] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 两次结果里所有**不相等**的路径（叶节点路径），用来兜住"只断言了我想到的字段"。 */
function diffPaths(a, b, prefix = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  out.push(prefix || '(root)');
  return out;
}

/**
 * 允许两次之间不同的路径 —— 只有这三类，且每类都有理由：
 *   - `cached`：它天生就是 true/false；
 *   - `plan.trace` 的 `hwaccel:` 行：`hwaccelUsed` 只在缓存回调里赋值，命中时无从得知
 *     （清单里少一行提示，**不影响任何取舍**；哪天真要修就是把它写进缓存条目）；
 *   - `cuts.*.evidence.*`：命中时指纹是 8 fps、分数按指纹帧率压过桶，`pulse`/`nv`/`corr`/
 *     `conc` 这些**数值**必然有小幅偏移。当前样本里没有落在判据边界上的刀，所以 `type` 不变；
 *     这个白名单**只放数值，不放 `type`** —— 标签一变就是 bug，必须红。
 */
const ALLOWED_DIFF = /^(cached|plan\.trace(\.\d+)?|cuts\.\d+\.evidence\.[A-Za-z]+)$/;

/** 把一次运行压成"要紧的那几个字段"，失败信息比 deepEqual 整对象好读 */
const shapeOf = (r) => ({
  cuts: r.cuts.map((c) => ({ t: +Number(c.t).toFixed(3), type: c.type ?? null })),
  plan: {
    frames: r.plan.frames,
    cells: r.plan.cells,
    sheets: r.plan.sheets,
    tiers: r.plan.tiers,
  },
});

/** evidence 数值漂移的幅度（只诊断，不失败：见 ALLOWED_DIFF 的说明） */
function evidenceDrift(a, b) {
  let max = 0;
  let where = '';
  for (let i = 0; i < Math.min(a.cuts.length, b.cuts.length); i += 1) {
    const ea = a.cuts[i].evidence ?? {};
    const eb = b.cuts[i].evidence ?? {};
    for (const k of Object.keys(ea)) {
      if (typeof ea[k] !== 'number' || typeof eb[k] !== 'number') continue;
      const d = Math.abs(ea[k] - eb[k]);
      if (d > max) { max = d; where = `cuts[${i}].evidence.${k}: ${ea[k]} → ${eb[k]}`; }
    }
  }
  return max > 0 ? `最大 ${max}（${where}）` : '无';
}

/** miss → hit：连跑三遍的那套断言，两个后端共用一份 */
async function assertCacheStable(t, { input, extraOpts = {} }) {
  return withTempCache(async (dir) => {
    const opts = { input, planOnly: true, cache: true, ...extraOpts };
    const first = await runStoryboard(opts);
    const entries = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    const bytesAfterMiss = entries.map((n) => readFileSync(join(dir, n), 'utf8'));
    const second = await runStoryboard(opts);
    const third = await runStoryboard(opts);

    // ---- ① 第二次必须**真的**命中缓存：不是"看起来像"
    // `cached` 来自 scan.cached，只有 cache.js 的 withCache 在读到条目时才会置 true。
    assert.equal(first.cached, false, '第一次必须是 miss（否则整条用例在测"两次都是缓存"）');
    assert.equal(second.cached, true, '第二次必须命中缓存');
    assert.equal(third.cached, true, '第三次也必须命中缓存');
    assert.equal(entries.length, 1, `第一次运行应写回 1 个缓存条目，实际 ${entries.length}：${entries.join(',')}`);
    // 命中的那条**没有被改写**（改了 = 第二次其实又扫了一遍或又写了一次）
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => readFileSync(join(dir, n), 'utf8')),
      bytesAfterMiss,
      '缓存条目在命中期间不该被改写（重扫一次会让两次结果都"看起来对"，却掩盖了命中失效）',
    );

    // ---- ② 被测条件本身要成立：夹具帧率必须 ≠ 抽稀后的指纹帧率（8 fps）
    // 否则 printFps === fps，历史事故的那条路径根本没被走到，用例会"绿得毫无意义"。
    assert.ok(first.info.fps >= PRINT_FPS * 1.5,
      `夹具帧率 ${first.info.fps} 与抽稀帧率 ${PRINT_FPS} 太接近：` +
      `命中缓存时 printFps 与 fps 一样，测不到错位`);

    // ---- ③ 切点 / 标签 / 排布 逐字段相等
    assert.ok(first.cuts.length >= 3, `夹具应切出 ≥3 刀，实际 ${first.cuts.length}`);
    assert.deepEqual(shapeOf(second), shapeOf(first), '第二次（命中缓存）的 cuts / 标签 / 排布必须与第一次逐字段相等');
    assert.deepEqual(shapeOf(third), shapeOf(first), '第三次也必须相等（连着命中不许漂）');
    assert.equal(second.threshold, first.threshold, '阈值必须一致（缓存条目里带的就是它）');
    assert.deepEqual(second.summary, first.summary, '分数摘要必须一致');
    assert.deepEqual(second.variants, first.variants, 'planOnly 的各档张数必须一致');

    // ---- ④ 兜底：除了白名单里的那三类，任何字段都不许有差异
    const diffs = diffPaths(first, second);
    const bad = diffs.filter((p) => !ALLOWED_DIFF.test(p));
    assert.deepEqual(bad, [], `命中缓存后出现了不该有的差异：${bad.join(', ')}`);

    t.diagnostic(`${input.split(/[\\/]/).pop()} 命中后 evidence 数值漂移：${evidenceDrift(first, second)}`);
    return { first, second };
  });
}

test('hsv：同一进程连跑两次（miss → hit），cuts / 标签 / 排布逐字段相等', async (t) => {
  if (!existsSync(FLASH)) {
    return t.skip(`夹具不在：${FLASH}（可用 DSH_FIXTURE_CLIPS 指到 fixtures/clips）`);
  }
  const { first, second } = await assertCacheStable(t, { input: FLASH, extraOpts: { detector: 'hsv' } });

  // 夹具的"含金量"：必须有 flash 标签 —— 那是唯一读 means + scores 的判据，
  // 也是历史上从 hardcut 翻成 dissolve 的那条路。标签全被删光/夹具换掉都要在这里露出来。
  const types = shapeOf(first).cuts.map((c) => c.type);
  assert.ok(types.includes('flash'), `夹具应至少标出一刀 flash，实际 ${JSON.stringify(types)}`);
  assert.deepEqual(shapeOf(second).cuts.map((c) => c.type), types, '标签序列必须逐位相同');
});

/**
 * osm 环境：显式环境变量优先，其次按本仓库布局猜（`plugin/../env|models`）。
 * 少了任何一项 → skip（不是失败）：这台机器可能根本没有 GPU / torch / 权重。
 */
function osmConfig() {
  const python = process.env.DSH_OSM_PYTHON
    || join(HERE, '..', '..', 'env', 'venv', 'Scripts', 'python.exe');
  const ckpt = process.env.DSH_OSM_CKPT
    || join(HERE, '..', '..', 'models', 'omnishotcut_ckpt.pth');
  const bridge = process.env.DSH_OSM_BRIDGE
    || join(SRC, 'omnishotcut-bridge.py');
  const missing = [
    ['python', python], ['ckpt', ckpt], ['bridge', bridge],
  ].filter(([, p]) => !existsSync(p)).map(([n, p]) => `${n}=${p}`);
  return { python, ckpt, bridge, missing };
}

test('omnishotcut：同样的检查再跑一遍（miss → hit）', async (t) => {
  if (!existsSync(WHIP)) {
    return t.skip(`夹具不在：${WHIP}（可用 DSH_FIXTURE_CLIPS 指到 fixtures/clips）`);
  }
  const osm = osmConfig();
  if (osm.missing.length) {
    // 权重 / venv / 桥三者缺一就跑不起来 —— 这是环境状态，不是回归，跳过。
    return t.skip(`osm 环境不全，跳过（缺 ${osm.missing.join(' / ')}）`);
  }
  try {
    const { first } = await assertCacheStable(t, {
      input: WHIP,
      extraOpts: { detector: 'omnishotcut', omnishotcut: { python: osm.python, ckpt: osm.ckpt, bridge: osm.bridge } },
    });
    // osm 的产物里带后端自报的推理信息；命中缓存时它必须从条目里原样回来
    assert.ok(first.osm && typeof first.osm.ms === 'number', `osm 应回报推理耗时，实际 ${JSON.stringify(first.osm)}`);
  } catch (err) {
    // python 不在 / torch 装不全 / 权重加载失败 / 桥报错：一律当**环境**问题跳过，
    // 只有"两次结果不一致"这类断言失败才让用例红。
    const isAssertion = err?.name === 'AssertionError' || err?.code === 'ERR_ASSERTION';
    const envish = ['osm-not-configured', 'osm-bridge-missing', 'osm-unknown-detector'].includes(err?.code)
      || /osm|omnishotcut|python|torch|ckpt|bridge|权重/i.test(String(err?.message ?? err));
    if (!isAssertion && envish) {
      return t.skip(`osm 跑不起来（环境问题），跳过：${String(err?.message ?? err).slice(0, 160)}`);
    }
    throw err;
  }
});

/**
 * 反例护栏：**这一节就是"防止有人顺手改回去"**。
 *
 * 两半缺一不可（见文件头）：
 *   ① `cuts.js` 打标签用指纹自己的帧率（`printFps`），不用调用方的 `fps`；
 *   ② 帧率不一致时，喂给 `tagCuts` 的 `scores` 必须是按指纹帧率压过的 `scoresPack`；
 *   ③ `pipeline.js` 命中缓存时把 `means` 从条目里取回、把 `printFps` 解析成打包指纹的帧率。
 *
 * 改动这些行是允许的 —— 但必须**有意识地**改到这里，而不是顺手。
 */
test('反例护栏：打标签的帧率来自 printFps（读 cuts.js / pipeline.js 源码钉住）', () => {
  const cuts = readFileSync(join(SRC, 'cuts.js'), 'utf8');
  // 用 assert.ok(/re/.test(src)) 而不是 assert.match(src)：断言失败时不要把整个源文件
  // 倒进测试输出里（几百行噪音，真正要看的那一行反而被埋掉）。
  const has = (src, re, msg) => assert.ok(re.test(src), msg);

  // ① tagFps 由 printFps 决定（printFps 为 0/缺省才退回 fps）
  has(cuts, /const tagFps\s*=\s*Number\(printFps\)\s*>\s*0\s*\?\s*Number\(printFps\)\s*:\s*fps/,
    'cuts.js 里 tagFps 必须从 printFps 推出来（缺了它，命中缓存时指纹帧率与真实帧率不一致就会错位）');
  // ② 帧率不一致的判据仍然存在（否则 scores 会拿错帧率的曲线去算 conc）
  has(cuts, /const sameRate\s*=/, 'cuts.js 里应有 sameRate（指纹帧率 vs 真实帧率），它决定喂哪个 scores');

  // ③ tagCuts 的调用点：必须传 fps: tagFps，且不许写回 fps（那正是历史 bug 的写法）
  const at = cuts.indexOf('tagCuts(cuts, {');
  assert.ok(at > 0, 'cuts.js 里找不到 tagCuts(cuts, { ... }) 调用点');
  const call = cuts.slice(at, at + 400);
  has(call, /fps:\s*tagFps/, 'tagCuts 必须拿到 fps: tagFps');
  assert.ok(!/\bfps:\s*fps\b/.test(call), 'tagCuts 不许再收到调用方的 fps：命中缓存时它与指纹帧率不一致');
  assert.ok(!/^\s*fps,\s*$/m.test(call), 'tagCuts 的入参里不许出现裸 fps');
  has(call, /means,/, 'tagCuts 必须拿到 means（缺了它 flash.js 直接返回 type:null，白闪剔除在命中时失效）');

  const pipe = readFileSync(join(SRC, 'pipeline.js'), 'utf8');
  // ④ 命中缓存时 printFps = 打包指纹的帧率（不是 info.fps）
  has(pipe, /printFps\s*=\s*packedFps\(scan\.printPack,\s*info\.fps\)/,
    'pipeline.js 命中缓存时必须用 packedFps(printPack) 作为 printFps');
  // ⑤ 命中时 means 从条目里取回
  has(pipe, /if\s*\(!scanMeans\s*&&\s*Array\.isArray\(scan\.means\)\)\s*scanMeans\s*=\s*scan\.means/,
    'pipeline.js 命中缓存时必须把 means 从缓存条目里取回来');
  // ⑥ 缓存条目里存按指纹帧率压过的分数曲线
  has(pipe, /scores:\s*packScoresAt\(/, '缓存条目里的 scores 必须经 packScoresAt 压到指纹帧率');
  // ⑦ resolveCuts 的调用点必须把 printFps 传下去（漏了 → 退回 fps，等于没修）
  const rcAt = pipe.indexOf('const cutChain = resolveCuts({');
  assert.ok(rcAt > 0, 'pipeline.js 里找不到 resolveCuts 调用点');
  has(pipe.slice(rcAt, rcAt + 1200), /printFps/, 'resolveCuts 的入参里必须带 printFps');
});
