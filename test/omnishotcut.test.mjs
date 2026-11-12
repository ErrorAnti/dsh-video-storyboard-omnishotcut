import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OSM_DETECTOR_ID, OSM_MIN_GAP, dedupeCuts, hybridScan, runOmniShotCut,
} from '../src/storyboard/omnishotcut.js';

const PY = 'C:\\fake\\python.exe';
const BRIDGE = 'C:\\fake\\src\\storyboard\\omnishotcut-bridge.py';
const CKPT = 'C:\\fake\\weights\\omnishotcut_ckpt.pth';

/** 造一个假 exec：把 payload 当 stdout 那一行 JSON 吐回来，并记下 argv */
function fakeExec(payload, { code = 0, stderr = '', raw = null } = {}) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const stdout = raw !== null ? raw : `${JSON.stringify(payload)}\n`;
    return { code, stdout, stderr };
  };
  fn.calls = calls;
  return fn;
}

/**
 * 01-hardcut 的真机输出（8 段，切点落在 72/144/…/504 帧，24fps）：
 *   ranges [[0,72],[72,144],…,[504,576]]，intra 全 General，inter 里混一个 Sudden_Jump。
 * 桥把它折成 7 个 cuts_sec，全部 kind='cut'。
 */
const HARDCUT = {
  ok: true,
  fps: 24.0,
  frames: 576,
  shots: 8,
  cuts_sec: [3, 6, 9, 12, 15, 18, 21],
  transitions: [],
  labels: ['General', 'General', 'General', 'General', 'General', 'General', 'General'],
  mode: 'default',
  ms: 1183,
};

/**
 * 02b-dissolve1s 的真机输出（11 段 = 6 镜头 + 5 处叠化）：
 *   ranges [[0,49],[49,72],[72,97],[97,120],[120,145],[145,168],[168,193],[193,216],
 *           [216,242],[242,264],[264,312]]，intra 交替 General / Dissolve。
 * 桥判定：5 段 Dissolve → transitions，硬切点一个都不出（边界已由转场代表）。
 */
const DISSOLVE = {
  ok: true,
  fps: 24.0,
  frames: 312,
  shots: 11,
  cuts_sec: [],
  transitions: [
    { from: 2.042, to: 3.0, label: 'Dissolve' },
    { from: 4.042, to: 5.0, label: 'Dissolve' },
    { from: 6.042, to: 7.0, label: 'Dissolve' },
    { from: 8.042, to: 9.0, label: 'Dissolve' },
    { from: 10.083, to: 11.0, label: 'Dissolve' },
  ],
  labels: [],
  mode: 'default',
  ms: 546,
};

const baseArgs = { input: 'C:\\clips\\x.mp4', fps: 24, python: PY, bridge: BRIDGE, ckpt: CKPT };

test('runOmniShotCut: 正常返回 —— 7 刀、字号字段透传、argv 形状对', async () => {
  const exec = fakeExec(HARDCUT);
  const r = await runOmniShotCut({ ...baseArgs, exec });

  assert.equal(r.cuts.length, 7, '01-hardcut 应该是 7 刀');
  assert.deepEqual(r.cuts.map((c) => c.t), [3, 6, 9, 12, 15, 18, 21]);
  assert.ok(r.cuts.every((c) => c.kind === 'cut'), '没有转场，全部是 cut');
  assert.ok(r.cuts.every((c) => c.label === 'General'), 'label 取 intra 标签');
  assert.ok(r.cuts.every((c) => c.score === 0), 'OmniShotCut 不给分数，score 恒 0');
  assert.deepEqual(r.transitions, []);
  assert.equal(r.fps, 24);
  assert.equal(r.frames, 576);
  assert.equal(r.shots, 8);
  assert.equal(r.ms, 1183);

  // 注入点必须收到可执行文件 + 桥脚本 + 固定参数
  assert.equal(exec.calls.length, 1);
  const call = exec.calls[0];
  assert.equal(call.command, PY);
  assert.equal(call.windowsHide, true);
  assert.deepEqual(call.args, [
    BRIDGE, baseArgs.input, '--ckpt', CKPT, '--mode', 'default', '--overlap', '10',
  ], `argv 不对：${call.args.join(' ')}`);
});

test('runOmniShotCut: 转场折叠成中点一刀（5 段 Dissolve → 5 个中点）', async () => {
  const exec = fakeExec(DISSOLVE);
  const r = await runOmniShotCut({ ...baseArgs, exec });

  assert.equal(r.transitions.length, 5, '02b 应该有 5 段转场');
  assert.ok(r.transitions.every((t) => t.label === 'Dissolve'));
  assert.equal(r.cuts.length, 5, '5 段转场 → 5 刀，硬切点一个都不许出');
  assert.ok(r.cuts.every((c) => c.kind === 'transition'));
  assert.ok(r.cuts.every((c) => c.label === 'Dissolve'), 'label 原样带出');

  // t = (from+to)/2，from/to 也留着给清单展示
  const want = DISSOLVE.transitions.map((t) => Math.round(((t.from + t.to) / 2) * 1000) / 1000);
  assert.deepEqual(r.cuts.map((c) => c.t), want);
  assert.deepEqual(r.cuts.map((c) => [c.from, c.to]), DISSOLVE.transitions.map((t) => [t.from, t.to]));
  assert.deepEqual(r.cuts.map((c) => c.t), [2.521, 4.521, 6.521, 8.521, 10.542]);
});

test('hybridScan: 相邻切点 <0.08s 去重，保留 transition', async () => {
  // 桥给一刀 1.0s，同时给一段中点 1.02s 的转场 —— 两者相距 0.02s，是同一刀
  const exec = fakeExec({
    ok: true, fps: 24, frames: 576, shots: 4,
    cuts_sec: [1.0, 5.0], transitions: [{ from: 0.99, to: 1.05, label: 'Dissolve' }],
    labels: ['General', 'General'], mode: 'default', ms: 100,
  });

  const hsv = {
    cuts: [{ t: 9.9, score: 30 }],
    stats: [{ t: 0, score: 1 }],
    longStats: [],
    frames: 500,
    threshold: 15,
    degraded: null,
    summary: { mean: 1, p95: 3 },
    means: [1, 2, 3],
    prints: ['fp'],
    bars: 0.02,
    scoring: { mode: 'mc', normalized: false, minCutScore: 80 },
  };
  const seen = [];
  const hsvScan = async (opts) => { seen.push(opts); return hsv; };

  const r = await hybridScan({ ...baseArgs, start: 0, hsvScan, exec, scoreMode: 'mc', threshold: 'auto' });

  // 1.0 被 1.02 的转场吃掉；5.0 留着；hsv 的 9.9 必须消失（cuts 由 OSM 覆盖）
  assert.deepEqual(r.cuts.map((c) => c.t), [1.02, 5]);
  assert.deepEqual(r.cuts.map((c) => c.kind), ['transition', 'cut']);
  assert.equal(r.cuts[0].label, 'Dissolve');
  assert.ok(!r.cuts.some((c) => c.t === 9.9), 'hsv 的切点不许漏进 cuts');

  // 其余字段逐字段透传，一个都不许改
  assert.equal(r.stats, hsv.stats);
  assert.equal(r.longStats, hsv.longStats);
  assert.equal(r.means, hsv.means);
  assert.equal(r.prints, hsv.prints);
  assert.equal(r.summary, hsv.summary);
  assert.equal(r.threshold, hsv.threshold);
  assert.equal(r.degraded, hsv.degraded);
  assert.equal(r.bars, hsv.bars);
  assert.equal(r.frames, hsv.frames, 'frames 来自 hsvScan');

  // scoring 并入 detector / cutSource，原有键保留
  assert.deepEqual(r.scoring, {
    mode: 'mc', normalized: false, minCutScore: 80, detector: OSM_DETECTOR_ID, cutSource: 'omnishotcut',
  });
  assert.deepEqual(r.transitions, [{ from: 0.99, to: 1.05, label: 'Dissolve' }]);
  assert.deepEqual(r.osm, { ms: 100, shots: 4, fps: 24 });

  // hsvScan 收到的是扫描选项（OSM 专属键不许混进去）
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scoreMode, 'mc');
  assert.equal(seen[0].input, baseArgs.input);
  assert.ok(!('bridge' in seen[0]), 'bridge 不是 scanShots 的参数');
  assert.ok(!('ckpt' in seen[0]), 'ckpt 不是 scanShots 的参数');
});

test('dedupeCuts: 阈值边界与 transition 优先', () => {
  const cuts = [
    { t: 2.0, kind: 'cut' },
    { t: 2.5, kind: 'transition' },
    { t: 2.57, kind: 'cut' },     // 与 2.5 相距 0.07 < 0.08 → 被吃掉
    { t: 3.0, kind: 'cut' },
    { t: 3.08, kind: 'cut' },     // 正好 0.08 → 不算同一刀
  ];
  const out = dedupeCuts(cuts, OSM_MIN_GAP);
  assert.deepEqual(out.map((c) => c.t), [2.0, 2.5, 3.0, 3.08]);

  // 反过来：先来的 cut 被后来的 transition 替代
  const swapped = dedupeCuts([{ t: 1.0, kind: 'cut' }, { t: 1.03, kind: 'transition', label: 'Fade' }]);
  assert.equal(swapped.length, 1);
  assert.equal(swapped[0].kind, 'transition');
  assert.equal(swapped[0].t, 1.03);
});

test('runOmniShotCut: 桥报错时抛 err.code（no-weights）', async () => {
  const exec = fakeExec({ ok: false, code: 'no-weights', message: CKPT, ms: 3 });
  await assert.rejects(
    () => runOmniShotCut({ ...baseArgs, exec }),
    (err) => {
      assert.equal(err.code, 'no-weights');
      assert.match(err.message, /no-weights/);
      assert.equal(err.bridgeCode, 'no-weights');
      return true;
    },
  );
});

test('runOmniShotCut: 超时 —— 假 exec 永不作答也要报 timeout', async () => {
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  await assert.rejects(
    () => runOmniShotCut({ ...baseArgs, exec: hang, timeoutMs: 60 }),
    (err) => {
      assert.equal(err.code, 'timeout');
      assert.equal(err.timeoutMs, 60);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 3000, '超时必须在 timeoutMs 附近收口，不能挂着');
});

test('runOmniShotCut: 桥非零退出 / stdout 不是 JSON —— 各有独立错误码', async () => {
  await assert.rejects(
    () => runOmniShotCut({ ...baseArgs, exec: fakeExec(null, { code: 3, stderr: 'boom' }) }),
    (err) => err.code === 'exit-3' && /boom/.test(err.message),
  );
  await assert.rejects(
    () => runOmniShotCut({ ...baseArgs, exec: fakeExec(null, { raw: 'Traceback (most recent call last):\n' }) }),
    (err) => err.code === 'bridge-json',
  );
});

test('runOmniShotCut: 缺 python/bridge/ckpt 时抛 missing-path（不吃环境变量残留）', async () => {
  const saved = {};
  for (const k of ['DSH_OSM_PYTHON', 'DSH_OSM_BRIDGE', 'DSH_OSM_CKPT']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    await assert.rejects(
      () => runOmniShotCut({ input: 'x.mp4', fps: 24, bridge: BRIDGE, ckpt: CKPT, exec: fakeExec(HARDCUT) }),
      (err) => err.code === 'missing-path' && err.field === 'python',
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test('hybridScan: HSV 那一路失败时 err.stage=「hsv」，OSM 的错误不被吞', async () => {
  const hsvScan = async () => { throw Object.assign(new Error('ffmpeg 丢了'), { code: 'scan-failed' }); };
  await assert.rejects(
    () => hybridScan({ ...baseArgs, hsvScan, exec: fakeExec(HARDCUT) }),
    (err) => err.code === 'scan-failed' && err.stage === 'hsv',
  );

  const okHsv = async () => ({ cuts: [], stats: [], longStats: [], frames: 1, threshold: 1, scoring: {} });
  await assert.rejects(
    () => hybridScan({ ...baseArgs, hsvScan: okHsv, exec: fakeExec({ ok: false, code: 'load-failed', message: 'bad ckpt' }) }),
    (err) => err.code === 'load-failed' && err.stage === 'osm',
  );
});
