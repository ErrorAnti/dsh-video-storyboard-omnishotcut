/**
 * detectors.test.mjs — 后端注册表的**不变量**。
 *
 * 这些断言的目的不是"测某一次改动"，而是"以后加模型时不用再回来改测试"：
 *   · 表里每个 id 都必须能被 `getDetector` 解析（新增一项自动被覆盖）；
 *   · `DETECTOR_IDS`（配置层认得的名字）必须**等于**表里的 id —— 不许有第二份清单；
 *   · 每一项的 `bypassStages` 只能是 cuts.js 真有的阶段名 —— 拼错就等于静默失效；
 *   · pipeline.js 里不许再出现按后端名字分叉的字符串比较。
 *
 * 后端的**行为**（桥协议、去重、分数补偿）在 omnishotcut.test.mjs / cut-score.test.mjs 里，
 * 这里只管"表本身接得对不对"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DETECTOR_IDS as CONFIG_DETECTOR_IDS, resolveDetectorConfig,
} from '../src/storyboard/user-config.js';
import { DETECTOR_IDS, detectorIds, detectors, getDetector } from '../src/storyboard/detectors/index.js';
import { OSM_DETECTOR_ID, OSM_MIN_GAP } from '../src/storyboard/omnishotcut.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE = join(HERE, '..', 'src', 'storyboard', 'pipeline.js');

/** cuts.js 里那两个开关认识的名字（见 cuts.js 头注释的阶段表）。 */
const KNOWN_STAGES = new Set(['still-spikes', 'refine-bursts']);

/** 一项必须有的字段（少一个 = pipeline 会在运行时 undefined）。 */
const FIELDS = ['id', 'label', 'needsCurve', 'bypassStages', 'minGap', 'resolve', 'scan', 'doctorChecks'];

/* ---------------------------------------------------------------- 表本身 */

test('注册表：每个 id 都能被 getDetector 解析，且解析回来的就是那一项', () => {
  const ids = detectorIds();
  assert.ok(ids.length >= 2, `表里至少要有 hsv 与 omnishotcut，实际 ${ids.join(',')}`);
  for (const id of ids) {
    const entry = getDetector(id);
    assert.ok(entry, `getDetector('${id}') 必须能解析`);
    assert.equal(entry.id, id, 'entry.id 必须与表里的键一致');
  }
  // 重复 id 会让后一项悄悄覆盖前一项
  assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.join(',')}`);
  // 顺序有意义：`detector must be one of …` 的列举顺序跟着它走
  assert.equal(ids[0], 'hsv', 'hsv 必须是第一项（默认档）');
});

test('注册表：不认识的 id 返回 null，大小写不敏感', () => {
  assert.equal(getDetector('nope'), null);
  assert.equal(getDetector(''), null);
  assert.equal(getDetector(undefined), null);
  assert.equal(getDetector('HSV'), getDetector('hsv'));
  assert.equal(getDetector(' OmniShotCut '), getDetector('omnishotcut'));
});

test('注册表：配置层认得的名字就是表里的 id（没有第二份清单）', () => {
  assert.deepEqual([...DETECTOR_IDS], detectorIds());
  assert.deepEqual([...CONFIG_DETECTOR_IDS], detectorIds(), 'user-config.js 必须 re-export 注册表里的那份');
  // `resolveDetectorConfig()` 报错文案用的就是 DETECTOR_IDS：加一项就自动出现在提示里
  const cfg = resolveDetectorConfig({ detector: 'hsv', data: {}, env: {} });
  assert.equal(cfg.detector, 'hsv');
});

test('注册表：每一项的字段都齐全，bypassStages 只能是 cuts.js 真有的阶段名', () => {
  for (const entry of detectors()) {
    for (const f of FIELDS) {
      assert.ok(f in entry, `${entry.id} 缺字段 ${f}`);
    }
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.needsCurve, 'boolean');
    assert.equal(typeof entry.resolve, 'function');
    assert.equal(typeof entry.scan, 'function');
    assert.equal(typeof entry.doctorChecks, 'function');
    assert.ok(Array.isArray(entry.bypassStages), `${entry.id}.bypassStages 必须是数组`);
    for (const stage of entry.bypassStages) {
      assert.ok(KNOWN_STAGES.has(stage), `${entry.id} 声明了不存在的阶段名 '${stage}'（cuts.js 只认 ${[...KNOWN_STAGES].join(' / ')}）`);
    }
    assert.ok(Number.isFinite(entry.minGap) && entry.minGap >= 0, `${entry.id}.minGap 必须是 >= 0 的数`);
  }
});

test('注册表：现役后端都要曲线（needsCurve），且只有模型后端关补刀阶段', async () => {
  for (const entry of detectors()) {
    assert.equal(entry.needsCurve, true, `${entry.id}: 逐帧曲线仍由 HSV 给，现役后端都是 true`);
  }
  assert.deepEqual(getDetector('hsv').bypassStages, [], 'hsv 的两个补刀阶段都要开着');
  // **只关阶段 1，阶段 2 必须开着**（2026-11-13 实测，别改回去）：
  // OmniShotCut 会把某些段落标成 `Padding`，桥按契约丢掉该段两侧边界 —— PPT/录屏类素材上
  // 实测 deck.mp4 从 8 页只切出 4 页；保留阶段 2（爆点细扫）能把它捞回来（4/8 → 8/8）。
  // 阶段 1（极静补刀）则相反：它的入口门槛 perSec<0.1 在 OSM 的切点上基本不成立，6 条素材
  // 一次都没触发，关掉零影响。
  assert.deepEqual(
    [...getDetector('omnishotcut').bypassStages].sort(),
    ['still-spikes'],
    'osm 只关阶段 1；阶段 2 是 Padding 段的补救手段，必须保留',
  );
  // 表里那个数就是适配器的常数（两个地方各写一遍，靠这条盯着）
  assert.equal(getDetector('omnishotcut').minGap, OSM_MIN_GAP);
  assert.equal(getDetector('hsv').minGap, 0, 'hsv 的近邻合并发生在 scanShots 内部，表这一层不再二次去重');
});

/* ---------------------------------------------------------------- hsv 项 */

test('hsv 项：resolve 什么都不用（零依赖），scan 就是跑一遍曲线', async () => {
  const entry = getDetector('hsv');
  assert.deepEqual(entry.resolve({}), {});
  assert.deepEqual(await entry.resolve({ omnishotcut: {} }), {}, 'hsv 机器上没装 python 是正常状态');

  const curveResult = { cuts: [{ t: 1, score: 10 }], stats: [], means: [], prints: [] };
  let called = 0;
  const r = await entry.scan({ curve: () => { called += 1; return curveResult; } });
  assert.equal(called, 1);
  assert.equal(r, curveResult, 'hsv 的 scan 必须原样返回 scanShots 的结果，一个字段都不改');
});

test('hsv 项：doctorChecks 恒绿，并给出换后端的写法', async () => {
  const items = await getDetector('hsv').doctorChecks({ sourceText: '内置默认' });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'hsv');
  assert.equal(items[0].ok, true);
  assert.match(items[0].detail, /detector=hsv（内置默认）/);
  assert.ok(items[0].lines.some((l) => l.includes('OmniShotCut')));
});

/* ---------------------------------------------------------------- omnishotcut 项 */

test('omnishotcut 项：label 说清版本', () => {
  assert.equal(getDetector('omnishotcut').label, 'OmniShotCut v1.5');
});

test('omnishotcut.resolve：缺 python/ckpt 抛 osm-not-configured（不回退），桥不在抛 osm-bridge-missing', async () => {
  const entry = getDetector('omnishotcut');

  // 什么都没配
  await assert.rejects(
    () => entry.resolve({ configPath: 'C:/video.json', omnishotcut: {} }),
    (err) => {
      assert.equal(err.code, 'osm-not-configured');
      assert.deepEqual(err.missing, ['python', 'ckpt']);
      assert.equal(err.detector, 'omnishotcut');
      assert.equal(err.configPath, 'C:/video.json');
      assert.match(err.message, /Not falling back to hsv/);
      return true;
    },
  );

  // 只缺权重
  await assert.rejects(
    () => entry.resolve({ omnishotcut: { python: 'C:/py.exe', bridgeExists: true } }),
    (err) => {
      assert.equal(err.code, 'osm-not-configured');
      assert.deepEqual(err.missing, ['ckpt']);
      return true;
    },
  );

  // 路径都配了，但桥文件不在
  await assert.rejects(
    () => entry.resolve({
      omnishotcut: { python: 'C:/py.exe', ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: false },
    }),
    (err) => {
      assert.equal(err.code, 'osm-bridge-missing');
      assert.equal(err.bridge, 'C:/b.py');
      return true;
    },
  );

  // 配全了：原样交出去（pipeline 拿去 spawn）
  assert.deepEqual(
    await entry.resolve({
      omnishotcut: {
        python: 'C:/py.exe', ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: true, source: { python: 'env' },
      },
    }),
    { python: 'C:/py.exe', bridge: 'C:/b.py', ckpt: 'C:/w.pth', source: { python: 'env' } },
  );
});

test('omnishotcut.scan：表里这一项真的接到适配器（cuts 来自桥、scoring 标后端）', async () => {
  const entry = getDetector('omnishotcut');
  const payload = {
    ok: true, fps: 24, frames: 576, shots: 8,
    cuts_sec: [3, 6], transitions: [], labels: ['General', 'General'], mode: 'default', ms: 42,
  };
  const calls = [];
  const exec = async (opts) => {
    calls.push(opts);
    return { code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: '' };
  };
  const hsv = {
    cuts: [{ t: 99, score: 5 }],
    stats: [{ t: 3, score: 4 }, { t: 6, score: 8 }],
    prints: ['fp'], means: [1], frames: 576, threshold: 'auto',
    summary: { frames: 576, p90: 1, p99: 2 },
    scoring: { mode: 'mc' },
  };
  let curveCalls = 0;
  const r = await entry.scan({
    input: 'C:/v.mp4', fps: 24, start: 0, end: 12,
    env: { python: 'C:/py.exe', bridge: 'C:/b.py', ckpt: 'C:/w.pth' },
    curve: async () => { curveCalls += 1; return hsv; },
    exec,
  });

  assert.equal(curveCalls, 1, '模型后端仍要先拿 HSV 曲线（means/prints/档位靠它）');
  assert.equal(calls.length, 1, '桥必须真被调用一次');
  assert.deepEqual(calls[0].args.slice(0, 4), ['C:/b.py', 'C:/v.mp4', '--ckpt', 'C:/w.pth']);
  assert.deepEqual(r.cuts.map((c) => c.t), [3, 6], 'cuts 取桥的，不许混进 hsv 的 99');
  assert.equal(r.scoring.detector, OSM_DETECTOR_ID);
  assert.equal(r.scoring.cutSource, 'omnishotcut');
  assert.equal(r.stats, hsv.stats, '曲线字段原样透传');
  assert.deepEqual(r.osm, { ms: 42, shots: 8, fps: 24 });
});

test('omnishotcut.doctorChecks：四项全绿 / 缺 python / 权重太小 / 桥不在，逐项报', async () => {
  const entry = getDetector('omnishotcut');
  // 两条探针：`python -c IMPORT_PROBE`（python 项）与 `python <bridge> --probe-device`（device 项）
  const probePayload = {
    ok: true, requested: 'auto', device: 'cpu', threads: 4,
    torch: '2.11.0+cpu', flavor: '2.11.0+cpu', torchvision: '0.26.0+cpu',
    cudaAvailable: false, cudaVersion: null, gpu: null,
  };
  const ctx = (omnishotcut, { pyOk = true, size = 200 * 1024 * 1024 } = {}) => ({
    config: { configPath: 'C:/video.json', omnishotcut },
    sourceText: '显式传参',
    run: async (_bin, args) => {
      if (Array.isArray(args) && args.includes('--probe-device')) {
        return { code: 0, stdout: `${JSON.stringify(probePayload)}\n`, stderr: '' };
      }
      return pyOk
        ? { code: 0, stdout: '1.5\n3.12.1\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'ModuleNotFoundError: No module named omnishotcut' };
    },
    stat: async () => (size === null ? null : { size }),
  });

  const all = await entry.doctorChecks(ctx({
    python: 'C:/py.exe', ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: true,
  }));
  assert.deepEqual(all.map((i) => i.name), ['config-source', 'python', 'device', 'ckpt', 'bridge']);
  assert.equal(all.filter((i) => i.quiet).length, 1, '只有"配置来源"是纯文本行');
  assert.ok(all.every((i) => i.ok), '配全时要全绿');
  assert.match(all[0].lines[0], /配置来源：C:\/video\.json（detector: 显式传参）/);
  assert.match(all[1].detail, /import omnishotcut 1\.5 \(Python 3\.12\.1\)/);
  assert.match(all[2].detail, /device: cpu — torch 2\.11\.0\+cpu, threads 4/);
  assert.match(all[3].detail, /权重：C:\/w\.pth \(200 MB\)/);

  const noPy = await entry.doctorChecks(ctx({ ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: true }));
  const py = noPy.find((i) => i.name === 'python');
  assert.equal(py.ok, false);
  assert.match(py.detail, /没配 python/);
  const noPyDev = noPy.find((i) => i.name === 'device');
  assert.equal(noPyDev.quiet, true, '没 python 时设备项只留一行说明，不再叠一条 ❌');
  assert.match(noPyDev.lines[0], /跳过探测（没配 python）/);

  const pyBroken = await entry.doctorChecks(ctx(
    { python: 'C:/py.exe', ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: true },
    { pyOk: false },
  ));
  const pyItem = pyBroken.find((i) => i.name === 'python');
  assert.equal(pyItem.ok, false);
  assert.ok(pyItem.lines.some((l) => l.includes('No module named omnishotcut')), '原文最后一行要带出来');

  const smallCkpt = await entry.doctorChecks(ctx(
    { python: 'C:/py.exe', ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: true },
    { size: 4096 },
  ));
  const ck = smallCkpt.find((i) => i.name === 'ckpt');
  assert.equal(ck.ok, false);
  assert.match(ck.detail, /权重太小/);

  const noBridge = await entry.doctorChecks(ctx(
    { python: 'C:/py.exe', ckpt: 'C:/w.pth', bridge: 'C:/b.py', bridgeExists: false },
  ));
  const br = noBridge.find((i) => i.name === 'bridge');
  assert.equal(br.ok, false);
  assert.match(br.detail, /Python 桥不在/);
  const noBridgeDev = noBridge.find((i) => i.name === 'device');
  assert.equal(noBridgeDev.quiet, true, '桥不在时设备项也不该再叠一条 ❌');
});

/* ---------------------------------------------------------------- pipeline 侧 */

test('pipeline：不再有按后端名字分叉的字符串比较（表以外不许有第二套判断）', () => {
  const src = readFileSync(PIPELINE, 'utf8');
  for (const other of ['omnishotcut', 'hsv']) {
    assert.ok(!new RegExp(`===\\s*'${other}'`).test(src), `pipeline.js 里还有 === '${other}'`);
    assert.ok(!new RegExp(`!==\\s*'${other}'`).test(src), `pipeline.js 里还有 !== '${other}'`);
  }
  // 表里的调用点：查表 + 三件事（resolve / scan / bypassStages）
  assert.match(src, /getDetector\(detectorId\)/);
  assert.match(src, /detectorImpl\.scan\(/);
  assert.match(src, /bypassStages\.has\('still-spikes'\)/);
  assert.match(src, /bypassStages\.has\('refine-bursts'\)/);
});

test('注册表：图省事的静态 import 不许出现在条目里（hsv 路径不该把适配器读进内存）', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'storyboard', 'detectors', 'omnishotcut.js'), 'utf8');
  // 只认 `import('../omnishotcut.js')` 这种动态写法；一旦写成顶层静态 import，
  // 每一台只跑 hsv 的机器都会把桥协议（child_process / spawn）一起求值。
  const staticImport = /^\s*import\s+[^(']*from\s+['"]\.\.\/omnishotcut\.js['"]/m;
  assert.ok(!staticImport.test(src), 'detectors/omnishotcut.js 不许静态 import ../omnishotcut.js');
  assert.match(src, /import\('\.\.\/omnishotcut\.js'\)/, '要用动态 import');
});
