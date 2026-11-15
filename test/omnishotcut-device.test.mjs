/**
 * 设备自适应（`DSH_OSM_DEVICE` / `DSH_OSM_THREADS`）的判据。
 *
 * 为什么这些用例值得单独一个文件：设备策略有**两份实现**（桥里 Python 的
 * `resolve_device` 与这里 JS 的 `resolveDevice`），桥那份没法在 `node --test` 里跑
 * （要 2 GB 的 torch），所以 JS 这份必须逐条钉死，再由 doctor 的交叉校验兜住漂移。
 *
 * 判据来源：`bench/slim/REPORT.md`（CPU 与 GPU 切点 0 帧差异、4 线程最快）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OSM_DEFAULT_THREADS, OSM_DEVICE_CHOICES, OSM_DEVICE_ENV, OSM_THREADS_ENV,
  doctorChecks, parseTorchFlavor, resolveDevice, resolveThreads,
} from '../src/storyboard/omnishotcut.js';

const PY = 'C:\\fake\\python.exe';
const BRIDGE = 'C:\\fake\\src\\storyboard\\omnishotcut-bridge.py';
const CKPT = 'C:\\fake\\weights\\omnishotcut_ckpt.pth';

/* ------------------------------------------------------------ 设备解析（策略） */

test('resolveDevice: auto + 有卡 → cuda，线程交给 torch 默认（null）', () => {
  const r = resolveDevice({ requested: 'auto', cudaAvailable: true, env: {} });
  assert.equal(r.device, 'cuda');
  assert.equal(r.requested, 'auto');
  assert.equal(r.threads, null, 'cuda 不该动 torch 的线程数');
  assert.equal(r.cudaAvailable, true);
});

test('resolveDevice: auto + 无卡 → cpu，线程取默认 4', () => {
  const r = resolveDevice({ requested: 'auto', cudaAvailable: false, env: {} });
  assert.equal(r.device, 'cpu');
  assert.equal(r.threads, OSM_DEFAULT_THREADS);
  assert.equal(OSM_DEFAULT_THREADS, 4, '默认值必须是实测最快的 4');
});

test('resolveDevice: 显式 cuda 但不可用 → 抛 device-unavailable（不静默降级）', () => {
  assert.throws(
    () => resolveDevice({ requested: 'cuda', cudaAvailable: false, env: {} }),
    (err) => {
      assert.equal(err.code, 'device-unavailable');
      assert.match(err.message, /看不到可用显卡/);
      assert.match(err.message, /install-omnishotcut\.ps1/, '报错里要给出修法');
      assert.match(err.message, /不会静默降级/);
      return true;
    },
  );
});

test('resolveDevice: 显式 cpu + 有卡 → 仍然 cpu（这就是"模拟无卡"那条路）', () => {
  const r = resolveDevice({ requested: 'cpu', cudaAvailable: true, env: {} });
  assert.equal(r.device, 'cpu');
  assert.equal(r.cudaAvailable, true, 'cudaAvailable 是事实，device 是选择，两者分开报');
  assert.equal(r.threads, 4);
});

test('resolveDevice: 非法取值 → device-invalid；大小写与空白归一化', () => {
  assert.throws(
    () => resolveDevice({ requested: 'rocm', cudaAvailable: true, env: {} }),
    (err) => err.code === 'device-invalid' && /只认 auto \/ cpu \/ cuda/.test(err.message),
  );
  assert.equal(resolveDevice({ requested: ' CPU ', cudaAvailable: true, env: {} }).device, 'cpu');
  assert.equal(resolveDevice({ requested: 'CUDA', cudaAvailable: true, env: {} }).device, 'cuda');
  assert.deepEqual(OSM_DEVICE_CHOICES, ['auto', 'cpu', 'cuda']);
});

test('resolveDevice: 不传 requested 时读 DSH_OSM_DEVICE（缺省 auto）', () => {
  assert.equal(resolveDevice({ cudaAvailable: false, env: {} }).requested, 'auto');
  assert.equal(
    resolveDevice({ cudaAvailable: true, env: { [OSM_DEVICE_ENV]: 'cpu' } }).device,
    'cpu',
  );
  assert.equal(
    resolveDevice({ cudaAvailable: false, env: { [OSM_DEVICE_ENV]: '' } }).device,
    'cpu',
    '空字符串按 auto 处理',
  );
});

/* ------------------------------------------------------------ 线程数 */

test('resolveThreads: DSH_OSM_THREADS 覆盖默认值，非法值抛 threads-invalid', () => {
  assert.equal(resolveThreads({ env: {} }), 4);
  assert.equal(resolveThreads({ env: { [OSM_THREADS_ENV]: '8' } }), 8);
  for (const bad of ['0', '-2', 'abc', '1.5']) {
    assert.throws(
      () => resolveThreads({ env: { [OSM_THREADS_ENV]: bad } }),
      (err) => err.code === 'threads-invalid',
      `${bad} 应该被拒`,
    );
  }
  // 从 resolveDevice 走同一条路：cpu 才读线程数，cuda 不读
  assert.equal(
    resolveDevice({ cudaAvailable: false, env: { [OSM_THREADS_ENV]: '6' } }).threads,
    6,
  );
  assert.equal(
    resolveDevice({ cudaAvailable: true, env: { [OSM_THREADS_ENV]: '6' } }).threads,
    null,
  );
  assert.throws(
    () => resolveDevice({ cudaAvailable: false, env: { [OSM_THREADS_ENV]: 'x' } }),
    (err) => err.code === 'threads-invalid',
  );
});

/* ------------------------------------------------------------ torch 版本串 */

test('parseTorchFlavor: 拆出 +cu128 / +cpu，没有本地标记时按 cudaVersion 补', () => {
  assert.deepEqual(
    parseTorchFlavor('2.11.0+cu128', '12.8'),
    { version: '2.11.0+cu128', flavor: 'cu128', label: '2.11.0+cu128' },
  );
  assert.deepEqual(
    parseTorchFlavor('2.11.0+cpu', null),
    { version: '2.11.0+cpu', flavor: 'cpu', label: '2.11.0+cpu' },
  );
  // 事故形态：`pip list` 里只有 2.11.0 —— 靠 torch.version.cuda 判断它到底是哪版
  assert.deepEqual(
    parseTorchFlavor('2.11.0', '12.8'),
    { version: '2.11.0', flavor: 'cu128', label: '2.11.0+cu128' },
  );
  assert.deepEqual(
    parseTorchFlavor('2.11.0', null),
    { version: '2.11.0', flavor: 'cpu', label: '2.11.0+cpu' },
  );
  assert.deepEqual(parseTorchFlavor(undefined, null), { version: '?', flavor: 'cpu', label: '?+cpu' });
});

/* ------------------------------------------------------------ doctor 的设备项 */

/** doctor 的 ctx：两条探针按 args 分流，stat 恒给一个"够大"的权重 */
function doctorCtx({ probe, statSize = 200 * 1024 * 1024, omnishotcut } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      config: {
        configPath: 'C:/video.json',
        omnishotcut: omnishotcut ?? {
          python: PY, ckpt: CKPT, bridge: BRIDGE, bridgeExists: true,
        },
      },
      sourceText: '显式传参',
      run: async (bin, args, timeoutMs) => {
        calls.push({ bin, args, timeoutMs });
        if (Array.isArray(args) && args.includes('--probe-device')) {
          return probe ?? {
            code: 0,
            stdout: `${JSON.stringify({
              ok: true, requested: 'auto', device: 'cuda', threads: 8,
              torch: '2.11.0+cu128', flavor: '2.11.0+cu128', torchvision: '0.26.0+cu128',
              cudaAvailable: true, cudaVersion: '12.8', gpu: 'NVIDIA GeForce RTX 3050 Laptop GPU',
            })}\n`,
            stderr: '',
          };
        }
        return { code: 0, stdout: '1.5\n3.14.6\n', stderr: '' };
      },
      stat: async () => ({ size: statSize }),
    },
  };
}

const deviceOf = (items) => items.find((i) => i.name === 'device');

test('doctorChecks.device: 有卡时印出 device / torch 版本 / 线程数 / 卡名', async () => {
  const { ctx, calls } = doctorCtx();
  const items = await doctorChecks(ctx);
  const dev = deviceOf(items);

  assert.equal(dev.ok, true);
  assert.equal(dev.detail, 'device: cuda — torch 2.11.0+cu128, threads 8');
  assert.ok(dev.lines.some((l) => /requested=auto {2}cudaAvailable=true {2}gpu=NVIDIA/.test(l)),
    `追加行要带 requested / cudaAvailable / gpu：${dev.lines.join(' | ')}`);
  assert.ok(dev.lines.some((l) => l.includes('torchvision 0.26.0+cu128')));

  // 探针必须打给**桥**，而且给了 30 s 超时（import torch 慢，8 s 不够）
  const probeCall = calls.find((c) => Array.isArray(c.args) && c.args.includes('--probe-device'));
  assert.equal(probeCall.bin, PY);
  assert.deepEqual(probeCall.args, [BRIDGE, '--probe-device']);
  assert.equal(probeCall.timeoutMs, 30000);
});

test('doctorChecks.device: 显式 cuda 不可用 → FAIL + 修复建议（不是一句"设备错误"）', async () => {
  const { ctx } = doctorCtx({
    probe: {
      code: 3,
      stdout: `${JSON.stringify({
        ok: false, code: 'device-unavailable', requested: 'cuda',
        message: 'DSH_OSM_DEVICE=cuda，但 torch 2.11.0+cpu 看不到可用显卡。',
      })}\n`,
      stderr: 'omnishotcut-bridge: device-unavailable requested=cuda — torch cannot see a CUDA device',
    },
  });
  const dev = deviceOf(await doctorChecks(ctx));

  assert.equal(dev.ok, false, '显式 cuda 不可用必须算硬伤');
  assert.match(dev.detail, /设备不可用/);
  assert.match(dev.detail, /看不到可用显卡/);
  const all = dev.lines.join('\n');
  assert.match(all, /install-omnishotcut\.ps1/, '要指到安装脚本');
  assert.match(all, /DSH_OSM_DEVICE 设成 auto \/ cpu/, '要给出降级写法');
  assert.match(all, /nvidia-smi/, '要给出"有没有卡"的判据');
});

test('doctorChecks.device: 取值非法 → FAIL 并列出合法取值', async () => {
  const { ctx } = doctorCtx({
    probe: {
      code: 3,
      stdout: `${JSON.stringify({ ok: false, code: 'device-invalid', requested: 'rocm', message: "只认 auto / cpu / cuda" })}\n`,
      stderr: '',
    },
  });
  const dev = deviceOf(await doctorChecks(ctx));
  assert.equal(dev.ok, false);
  assert.match(dev.detail, /device-invalid/);
  assert.match(dev.lines.join('\n'), /只认 auto \/ cpu \/ cuda/);
});

test('doctorChecks.device: 探针吐的不是 JSON（比如 torch 没装）→ FAIL，带出 stderr', async () => {
  const { ctx } = doctorCtx({
    probe: { code: 1, stdout: '', stderr: 'ModuleNotFoundError: No module named torch' },
  });
  const dev = deviceOf(await doctorChecks(ctx));
  assert.equal(dev.ok, false);
  assert.match(dev.detail, /没拿到 JSON/);
  assert.ok(dev.lines.some((l) => l.includes('No module named torch')));
});

test('doctorChecks.device: 桥与 JS 判定不一致 → FAIL（两份策略漂移的探针）', async () => {
  // 桥说 cpu，但 auto + cudaAvailable=true 在 JS 里算出来是 cuda
  const { ctx } = doctorCtx({
    probe: {
      code: 0,
      stdout: `${JSON.stringify({
        ok: true, requested: 'auto', device: 'cpu', threads: 4,
        torch: '2.11.0+cu128', cudaAvailable: true, cudaVersion: '12.8', gpu: 'RTX',
      })}\n`,
      stderr: '',
    },
  });
  const dev = deviceOf(await doctorChecks(ctx));
  assert.equal(dev.ok, false);
  assert.match(dev.detail, /设备判定不一致：桥说 cpu，doctor 算 cuda/);
});

test('doctorChecks.device: 桥不在 / 没配 python 时是 quiet 跳过，不叠第二条 ❌', async () => {
  const noBridge = doctorCtx({
    omnishotcut: { python: PY, ckpt: CKPT, bridge: BRIDGE, bridgeExists: false },
  });
  const dev1 = deviceOf(await doctorChecks(noBridge.ctx));
  assert.equal(dev1.quiet, true);
  assert.match(dev1.lines[0], /跳过探测（桥脚本不在）/);

  const noPy = doctorCtx({ omnishotcut: { ckpt: CKPT, bridge: BRIDGE, bridgeExists: true } });
  const dev2 = deviceOf(await doctorChecks(noPy.ctx));
  assert.equal(dev2.quiet, true);
  assert.match(dev2.lines[0], /跳过探测（没配 python）/);
});
