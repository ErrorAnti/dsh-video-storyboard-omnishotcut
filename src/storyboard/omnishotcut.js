/**
 * omnishotcut.js — OmniShotCut 后端的 Node 适配器（契约：`docs/omnishotcut-backend.md` §2）。
 *
 * 职责只有一条：**把桥吐的那一行 JSON 变成扫描结果**。不做融合判定、不做加刀削刀 ——
 * 阶段 1–3（极静补刀 / 爆点细扫 / 丐中丐合并）留在 `cuts.js`，这里只负责"拿到边界"。
 *
 * 为什么要走子进程 + 一行 JSON：OmniShotCut 只有 Python 发行（torch），而整条
 * storyboard 链路的逐帧分数、指纹、亮度均值仍然由 HSV 扫描（`scan.js`）给 ——
 * 两套东西必须在同一个进程树里对齐时间轴，所以桥的 stdout 只有一行、单位只有秒。
 *
 * ## 注册表接口
 *
 * `detectors/omnishotcut.js` 这个条目只认本文件末尾的三个函数：
 * `resolve(cfg)`（配置校验，抛不回退）、`scan(opts)`（= hybridScan 加壳）、
 * `doctorChecks(ctx)`（自检三项，依赖注入，不起进程也能测）。
 * `hybridScan` 仍然是 `scan` 的内核，直接调用照旧可用。
 *
 * ## 注入点
 *
 * - `exec`：跑子进程的实现，默认 `node:child_process.spawn`（`windowsHide: true`，
 *   超时杀进程）。测试传假实现即可，不用真起 Python。
 *   形状：`(opts) => Promise<{code:number, stdout:string, stderr:string}>`，
 *   `opts = { command, args, timeoutMs, signal, windowsHide }`。
 * - `hsvScan`（`hybridScan` 专有）：`(opts) => Promise<scanShots结果>`。
 *   不在这里 `import { scanShots }`：`pipeline.js → omnishotcut.js → scan.js` 会绕成环。
 *
 * ## 错误码（`err.code`）
 *
 * | code | 含义 |
 * |---|---|
 * | `no-weights` / `no-package` / `load-failed` / `infer-failed` / `decode` | 桥原样上报（契约 §1） |
 * | `missing-path` | `python` / `bridge` / `ckpt` 没给（调用方负责解析绝对路径） |
 * | `spawn-failed` | 子进程起不来（ENOENT、权限） |
 * | `timeout` | 超过 `timeoutMs`，进程已被杀 |
 * | `aborted` | 传入的 `signal` 被 abort |
 * | `exit-<n>` | 桥非零退出（正常情况不会，契约要求错误也走 JSON + 退出码 0） |
 * | `bridge-json` | stdout 里没有可解析的 JSON 对象 |
 * | `missing-hsv-scan` / `hsv-failed` | `hybridScan` 的注入缺失 / HSV 那一路失败（`err.stage='hsv'`） |
 *
 * **绝不静默降级**：桥失败就抛，回不回退由调用方决定。
 */
import { spawn } from 'node:child_process';

/** 检测器标识（写进 `scan.scoring.detector`，缓存 key 也认它） */
export const OSM_DETECTOR_ID = 'omnishotcut-v1.5';

/**
 * 合并阈值（秒）。相距小于它的两点视为**同一刀**，`kind='transition'` 优先保留。
 * 契约 §2.1 写死 0.08s：24fps 下约 1.9 帧，正好卡住"转场中点与相邻边界贴在一起"的情形。
 */
export const OSM_MIN_GAP = 0.08;

/** 桥能返回的错误码（契约 §1）——仅用于报错文案，不用于吞错 */
const BRIDGE_CODES = ['no-weights', 'no-package', 'load-failed', 'infer-failed', 'decode'];

/** 子进程 stdout 上限：正常输出是几十字节，留 4MB 纯属防呆 */
const MAX_STDOUT = 4 * 1024 * 1024;

function codedError(code, message, extra = null) {
  const err = message instanceof Error ? message : new Error(String(message));
  if (!err.code || code) err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function round3(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
}

function tail(s, n = 400) {
  const t = String(s ?? '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * 默认 exec：`spawn` 一个子进程，收 stdout/stderr，超时或 abort 就杀掉。
 * 语义固定为 `{code, stdout, stderr}`，永不因非零退出而 reject —— 判定交给调用方，
 * 这样"桥自己说 ok:false"和"进程根本没起来"是两条能分开的路。
 */
function spawnExec({ command, args = [], timeoutMs = 0, signal, windowsHide = true }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(codedError('spawn-failed', err));
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;

    const onAbort = () => {
      settle(reject, codedError('aborted', `OmniShotCut 被 abort：${command}`));
      kill();
    };
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const settle = (fn, v) => {
      if (done) return;
      done = true;
      cleanup();
      fn(v);
    };
    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      // 兜底：CUDA 初始化阶段的 Python 偶尔吃掉第一次 kill
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }, 500).unref?.();
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      stdout += d;
      if (stdout.length > MAX_STDOUT) stdout = stdout.slice(-MAX_STDOUT);
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
      if (stderr.length > MAX_STDOUT) stderr = stderr.slice(-MAX_STDOUT);
    });

    child.on('error', (err) => settle(reject, codedError('spawn-failed', err)));
    child.on('close', (code, sig) => settle(resolve, { code: code ?? -1, signal: sig, stdout, stderr }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(reject, codedError('timeout', `OmniShotCut 超时（${timeoutMs}ms）`, { timeoutMs }));
        kill();
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
    return undefined;
  });
}

/**
 * 给任意 exec 的 Promise 套一层"超时 / abort"保险。
 * 假 exec 不会自己看超时，所以这一层必须独立存在（测试 ⑤ 就靠它）。
 */
function withGuard(promise, { timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const onAbort = () => finish(reject, codedError('aborted', 'OmniShotCut 被 abort'));
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      cleanup();
      fn(v);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(reject, codedError('timeout', `OmniShotCut 超时（${timeoutMs}ms）`, { timeoutMs }));
      }, timeoutMs);
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
    Promise.resolve(promise).then((v) => finish(resolve, v), (e) => finish(reject, e));
    return undefined;
  });
}

/**
 * 从 stdout 里取那一行 JSON。
 * 契约要求 stdout 只有一行，但 torch / HF 的告警偶尔会漏到 stdout —— 所以先试整段，
 * 再倒着找最后一个能解析成对象的行。
 */
function parseBridgePayload(stdout, stderr = '') {
  const raw = String(stdout ?? '').trim();
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const whole = raw ? tryParse(raw) : null;
  if (whole) return whole;
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const s = lines[i].trim();
    if (!s.startsWith('{')) continue;
    const v = tryParse(s);
    if (v && 'ok' in v) return v;
  }
  throw codedError(
    'bridge-json',
    `omnishotcut-bridge 的输出不是 JSON：stdout=${tail(raw, 200) || '(空)'} stderr=${tail(stderr, 200) || '(空)'}`,
    { stdout: tail(raw, 800), stderr: tail(stderr, 800) },
  );
}

/** 环境变量兜底（调用方显式传参优先）。仓库里不写死任何绝对路径，只认这里。 */
function envPath(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 只负责"拿到 OmniShotCut 的结果"，不做任何融合。
 *
 * @param {object} o
 * @param {string} o.input                 视频路径
 * @param {number} o.fps                   调用方已知的帧率（桥没给时兜底）
 * @param {number} [o.start=0]             窗口起点（秒）
 * @param {number} [o.end]                 窗口终点（秒）
 * @param {string} o.python                Python 解释器绝对路径（缺省读 DSH_OSM_PYTHON）
 * @param {string} o.bridge                桥脚本绝对路径（缺省读 DSH_OSM_BRIDGE）
 * @param {string} o.ckpt                  权重绝对路径（缺省读 DSH_OSM_CKPT）
 * @param {'default'|'clean_shot'} [o.mode='default']
 * @param {number} [o.overlap=10]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs=600000]
 * @param {Function|null} [o.exec=null]    注入点：`(opts) => Promise<{code,stdout,stderr}>`
 * @returns {Promise<{cuts:Array<{t:number,score:number,kind:'cut'|'transition',label?:string,from?:number,to?:number}>,
 *                    transitions:Array<{from:number,to:number,label:string}>,
 *                    fps:number, frames:number, shots:number, ms:number}>}
 *
 * `score` 恒为 0：OmniShotCut 只给边界、不给 0–255 曲线。需要分数的地方继续读
 * `scan.stats`（那是 HSV 扫描的产物，契约 §0.2 明确要求保留）。
 */
export async function runOmniShotCut({
  input, fps, start = 0, end,
  python, bridge, ckpt,
  mode = 'default', overlap = 10,
  signal, timeoutMs = 600000,
  exec = null,
} = {}) {
  if (!input) throw codedError('missing-path', 'runOmniShotCut: 缺少 input', { field: 'input' });

  const cmd = python || envPath('DSH_OSM_PYTHON');
  const script = bridge || envPath('DSH_OSM_BRIDGE');
  const weights = ckpt || envPath('DSH_OSM_CKPT');
  for (const [field, value] of Object.entries({ python: cmd, bridge: script, ckpt: weights })) {
    if (!value) {
      throw codedError(
        'missing-path',
        `runOmniShotCut: 缺少 ${field}（调用方负责解析绝对路径，或用 DSH_OSM_${field.toUpperCase()}）`,
        { field },
      );
    }
  }

  const args = [script, input, '--ckpt', weights];
  if (Number(start) > 0) args.push('--start', String(Number(start)));
  if (end !== undefined && end !== null) args.push('--end', String(Number(end)));
  args.push('--mode', mode, '--overlap', String(overlap));

  const runner = typeof exec === 'function' ? exec : spawnExec;
  const res = await withGuard(
    Promise.resolve().then(() => runner({ command: cmd, args, timeoutMs, signal, windowsHide: true })),
    { timeoutMs, signal },
  ) || {};

  const code = Number(res.code ?? 0);
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';

  if (code !== 0) {
    throw codedError(
      `exit-${code}`,
      `omnishotcut-bridge 退出码 ${code}${stderr ? `：${tail(stderr)}` : ''}`,
      { exitCode: code, stdout: tail(stdout, 800), stderr: tail(stderr, 800) },
    );
  }

  const payload = parseBridgePayload(stdout, stderr);
  if (!payload.ok) {
    const code2 = typeof payload.code === 'string' && payload.code ? payload.code : 'bridge-error';
    throw codedError(
      code2,
      `omnishotcut-bridge[${code2}]: ${payload.message || code2}${BRIDGE_CODES.includes(code2) ? '' : '（未知错误码）'}`,
      { bridgeCode: payload.code ?? null, stdout: tail(stdout, 800), stderr: tail(stderr, 800) },
    );
  }

  const outFps = Number(payload.fps) > 0 ? Number(payload.fps) : (Number(fps) > 0 ? Number(fps) : 0);
  const labels = Array.isArray(payload.labels) ? payload.labels : [];

  const transitions = (Array.isArray(payload.transitions) ? payload.transitions : [])
    .map((tr) => ({
      from: round3(tr?.from),
      to: round3(tr?.to),
      label: tr?.label === undefined || tr?.label === null ? 'Transition' : String(tr.label),
    }))
    .filter((tr) => Number.isFinite(tr.from) && Number.isFinite(tr.to));

  const cuts = [];
  const cutsSec = Array.isArray(payload.cuts_sec) ? payload.cuts_sec : [];
  cutsSec.forEach((t, i) => {
    const tt = round3(t);
    if (!Number.isFinite(tt)) return;
    const label = labels[i] === undefined || labels[i] === null ? 'General' : String(labels[i]);
    cuts.push({ t: tt, score: 0, kind: 'cut', label });
  });
  // 契约 §2：每个转场产生**一个** cuts 项，落在中点 —— v1 保持"单点切点"模型
  for (const tr of transitions) {
    cuts.push({
      t: round3((tr.from + tr.to) / 2),
      score: 0,
      kind: 'transition',
      label: tr.label,
      from: tr.from,
      to: tr.to,
    });
  }
  cuts.sort((a, b) => a.t - b.t);

  return {
    cuts,
    transitions,
    fps: outFps,
    frames: Number(payload.frames) || 0,
    shots: Number(payload.shots) || 0,
    ms: Number(payload.ms) || 0,
  };
}

/**
 * 排序 + 去重：相距 < `minGap` 的两点视为同一刀，`kind='transition'` 优先。
 *
 * 为什么是"保留 transition"：转场中点才是那段画面的代表点，硬切点是它的边界之一；
 * 两者撞在一起时留中点，清单上的时间戳与"这一段是叠化过去"的事实一致。
 */
export function dedupeCuts(cuts, minGap = OSM_MIN_GAP) {
  const rank = (c) => (c.kind === 'transition' ? 0 : 1);
  const list = (Array.isArray(cuts) ? cuts : [])
    .filter((c) => c && Number.isFinite(Number(c.t)))
    .map((c) => ({ ...c, t: Number(c.t) }))
    .sort((a, b) => a.t - b.t || rank(a) - rank(b));

  const out = [];
  for (const c of list) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(c.t - prev.t) < minGap) {
      if (prev.kind !== 'transition' && c.kind === 'transition') out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  return out;
}

function attachStage(err, stage) {
  const e = err instanceof Error ? err : codedError('unknown', String(err));
  e.stage = stage;
  e.detector = stage === 'osm' ? OSM_DETECTOR_ID : 'hsv';
  return e;
}

/**
 * 融合入口（给 pipeline 用）：HSV 扫描提供逐帧曲线/指纹，OmniShotCut 提供切点。
 *
 * 顺序：先 `hsvScan`、再 OmniShotCut（顺序执行，失败时 `err.stage` 能说清是哪一路）。
 * 返回形状与 `scanShots()` **完全一致**，外加 `transitions` 与 `osm`；
 * 唯一被覆盖的是 `cuts`（取 OmniShotCut 的）与 `scoring`（并入 detector/cutSource），
 * 其余字段一个都不动 —— `tiers.integralMarks` / `flash.tagCuts` 全靠它们。
 *
 * @param {object} o
 * @param {string} o.input
 * @param {number} o.fps
 * @param {number} [o.start=0]
 * @param {number} [o.end]
 * @param {Function} o.hsvScan          必传，`(opts) => Promise<scanShots结果>`
 * @param {string} [o.python]
 * @param {string} [o.bridge]
 * @param {string} [o.ckpt]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs=600000]
 * @param {Function|null} [o.exec=null]
 * @param {...any} 其余键**原样转交** `hsvScan`（`scoreMode` / `threshold` / `ffmpegPath` …）
 * @returns {Promise<object>}
 */
export async function hybridScan(opts = {}) {
  const {
    input, fps, start = 0, end, hsvScan,
    python, bridge, ckpt, signal, timeoutMs = 600000,
    mode = 'default', overlap = 10, exec = null,
    // 切点最小间隔：注册表（`detectors/index.js` 的 `minGap`）从这里喂进来的就是 0.08s，
    // 直接调用时缺省值仍是契约 §2.1 的那个常数 —— 两条路拿到的是同一个数。
    minGap = OSM_MIN_GAP,
    // 调用方可能把整块 pipeline 配置丢进来：这两个不是 scanShots 的参数，剔掉
    detector: _detector, omnishotcut: osmCfg,
    ...hsvOpts
  } = opts;

  if (typeof hsvScan !== 'function') {
    throw codedError('missing-hsv-scan', 'hybridScan: hsvScan 必传（依赖注入，避免 import scan.js 成环）');
  }

  let hsv;
  try {
    hsv = await hsvScan({ ...hsvOpts, input, fps, start, end, signal });
  } catch (err) {
    throw attachStage(err, 'hsv');
  }
  if (!hsv || typeof hsv !== 'object') {
    throw codedError('hsv-failed', 'hybridScan: hsvScan 没有返回扫描结果', { stage: 'hsv', detector: 'hsv' });
  }

  const resolved = osmCfg && typeof osmCfg === 'object' ? osmCfg : {};
  let osm;
  try {
    osm = await runOmniShotCut({
      input, fps, start, end,
      python: python ?? resolved.python,
      bridge: bridge ?? resolved.bridge,
      ckpt: ckpt ?? resolved.ckpt,
      mode, overlap, signal, timeoutMs, exec,
    });
  } catch (err) {
    throw attachStage(err, 'osm');
  }

  return {
    ...hsv,
    // 契约 §2.1：cuts 取 OmniShotCut 的（覆盖 hsv 的），排序去重
    cuts: fillCutsScore(dedupeCuts(osm.cuts, minGap), hsv.stats),
    scoring: { ...(hsv.scoring || {}), detector: OSM_DETECTOR_ID, cutSource: 'omnishotcut' },
    transitions: osm.transitions,
    osm: { ms: osm.ms, shots: osm.shots, fps: osm.fps },
  };
}

/**
 * 给 OmniShotCut 的切点补一个**有实际含义**的分数。
 *
 * 模型只给边界不给 0–255 曲线，所以 `score` 原本恒为 0；下游 `cuts.js` 阶段 3
 * （丐中丐合并）用 `suppressClose` 时会"保留分数更高的那一刀"，恒 0 就退化成"保留第一个"。
 * 这里借 HSV 曲线在切点邻域的峰值填进去：量级与 HSV 一致，合并时的取舍才有意义。
 *
 * 不改 `kind` / `label` / `from` / `to`，也不动顺序。
 */
export function fillCutsScore(cuts, stats, halfWindowSec = 0.12) {
  if (!Array.isArray(cuts) || cuts.length === 0) return cuts ?? [];
  if (!Array.isArray(stats) || stats.length === 0) return cuts;
  return cuts.map((c) => {
    let best = null;
    let nearest = null;
    for (const s of stats) {
      const t = Number(s?.t);
      const sc = Number(s?.score);
      if (!Number.isFinite(t) || !Number.isFinite(sc)) continue;
      const d = Math.abs(t - Number(c.t));
      if (!nearest || d < nearest.d) nearest = { d, sc };
      if (d <= halfWindowSec && (best === null || sc > best)) best = sc;
    }
    const score = best ?? nearest?.sc ?? 0;
    return { ...c, score: +Number(score).toFixed(2) };
  });
}

/* ================================================================ 注册表接口 ----
 * 注册表（`detectors/index.js`）只认三个函数：`resolve` / `scan` / `doctorChecks`。
 * 这三段以前散在 `pipeline.js`（配置校验）与 `bin/doctor.mjs`（自检）里，
 * 现在收回到**知道这个后端细节的那一个文件**——接第三个模型时不用碰 pipeline。
 *
 * 三个函数都只做"这个后端自己的事"，pipeline 不再出现任何 `=== 'omnishotcut'`。
 */

/**
 * 配置解析 + 校验。**抛，不回退。**
 *
 * 为什么必须抛：静默退回 hsv 会产出"看起来成功、但 cuts 全是另一个后端算的"结果 ——
 * 清单、缓存、下游档位都会照着它走，而没人能看出换了后端。宁可当场失败。
 *
 * 两种失败分开报：连路径都没配（`osm-not-configured`）与配了但文件不在
 * （`osm-bridge-missing`）是两件不同的事，用户的下一步也完全不同（写配置 vs 修路径）。
 *
 * @param {{omnishotcut: object, configPath?: string}} cfg `resolveDetectorConfig()` 的返回值
 * @returns {{python: string, bridge: string, ckpt: string, source: object}}
 */
export function resolve(cfg) {
  const osm = cfg?.omnishotcut ?? {};
  const where = cfg?.configPath ?? '~/.dsh/video.json';
  const missing = [...(osm.python ? [] : ['python']), ...(osm.ckpt ? [] : ['ckpt'])];
  if (missing.length > 0) {
    const err = new Error(
      `detector 'omnishotcut' needs ${missing.join(' + ')}: write them in ${where} `
      + '("omnishotcut": { "python": ..., "ckpt": ... }) or set DSH_OSM_PYTHON / DSH_OSM_CKPT. '
      + 'Not falling back to hsv — that would silently hand back HSV cuts under another name.',
    );
    err.code = 'osm-not-configured';
    err.missing = missing;
    err.detector = 'omnishotcut';
    err.configPath = where;
    throw err;
  }
  if (!osm.bridgeExists) {
    const err = new Error(
      `detector 'omnishotcut' needs the Python bridge, but ${osm.bridge} does not exist. `
      + 'Point "omnishotcut.bridge" (or DSH_OSM_BRIDGE) at src/storyboard/omnishotcut-bridge.py.',
    );
    err.code = 'osm-bridge-missing';
    err.bridge = osm.bridge;
    err.detector = 'omnishotcut';
    throw err;
  }
  return { python: osm.python, bridge: osm.bridge, ckpt: osm.ckpt, source: osm.source };
}

/**
 * 扫描：HSV 给曲线（`opts.curve`），OmniShotCut 给切点，`hybridScan` 负责把两者对齐。
 *
 * `opts.env` 是 `resolve()` 的返回值；`opts.curve` 是 pipeline 造的"跑一遍 HSV"回调
 * （它同时把 means / prints 留给 pipeline，那些字段等级链下游还要用）。
 * 其余键（`exec` / `signal` / `timeoutMs`）原样透传，测试可以塞假 exec 而不起 Python。
 *
 * @returns {Promise<object>} 与 `scanShots()` 同形，`cuts` 被换成后端的，外加 `transitions` / `osm`
 */
export async function scan(opts = {}) {
  const { env = {}, curve, minGap, ...rest } = opts;
  return hybridScan({
    ...rest,
    ...(Number(minGap) > 0 ? { minGap: Number(minGap) } : {}),
    hsvScan: curve,
    python: env.python, bridge: env.bridge, ckpt: env.ckpt,
  });
}

/** 权重体积地板：几十 KB 的占位文件 / Git LFS 指针不该等到第一次推理才炸。 */
export const MIN_CKPT_BYTES = 100 * 1024 * 1024;

/** doctor 里那条 import 探针 —— 与 `findPython` 同一判据：光"能执行"不算数。 */
const IMPORT_PROBE = 'import omnishotcut,sys;print(getattr(omnishotcut,"__version__","?"));'
  + 'print(sys.version.split()[0])';

/**
 * 自检项（`bin/doctor.mjs` 只负责打印，判断都在这儿）。
 *
 * 返回 `[{name, ok, detail?, lines?, quiet?, fatal?}]`：
 * - `detail` 是 ✅/❌ 后面那句话，`lines` 是原样打印的追加行（箭头提示自带缩进）；
 * - `quiet: true` 表示"只有 lines，没有 ✅/❌"（配置来源那一行就是这种）；
 * - `fatal: false` 表示不算硬伤（默认 `ok:false` 就算）。
 *
 * 依赖全部注入：`run(bin, args) -> {code, stdout, stderr}`、`stat(p) -> stat|null`。
 * 所以这个函数不起进程也能测。
 */
export async function doctorChecks({ config, sourceText, run, stat } = {}) {
  const osm = config?.omnishotcut ?? {};
  const src = sourceText ?? config?.source ?? '内置默认';
  const out = [{
    name: 'config-source',
    ok: true,
    quiet: true,
    lines: [`     配置来源：${config?.configPath ?? '~/.dsh/video.json'}（detector: ${src}）`],
  }];

  // ---- python：要的那一个包必须真能 import 进来
  if (!osm.python) {
    out.push({
      name: 'python', ok: false,
      detail: '没配 python —— detector=omnishotcut 起不来（不会回退到 hsv）',
      lines: [
        '     → ~/.dsh/video.json 的 "omnishotcut.python" 指到装好 omnishotcut 的解释器，',
        '       或设 DSH_OSM_PYTHON（Windows 例：D:/osm/.venv/Scripts/python.exe）',
      ],
    });
  } else {
    const r = await run(osm.python, ['-c', IMPORT_PROBE]);
    if (r?.code === 0) {
      const [ver = '?', pyVer = '?'] = String(r.stdout ?? '').trim().split(/\r?\n/);
      out.push({ name: 'python', ok: true, detail: `python: ${osm.python} — import omnishotcut ${ver} (Python ${pyVer})` });
    } else {
      const why = String(r?.stderr || r?.stdout || '').trim().split(/\r?\n/).pop() ?? '';
      out.push({
        name: 'python', ok: false,
        detail: `python 跑不起来或 import omnishotcut 失败：${osm.python}`,
        lines: [
          ...(why ? [`       ${why.slice(0, 160)}`] : []),
          '     → 在那台解释器里装：pip install omnishotcut torch；',
          '       若是 "No module named omnishotcut"，说明配的是另一个环境',
        ],
      });
    }
  }

  // ---- 权重：要有，而且明显不对的（占位文件 / LFS 指针）要当场说
  if (!osm.ckpt) {
    out.push({
      name: 'ckpt', ok: false,
      detail: '没配 ckpt（权重）—— detector=omnishotcut 起不来（不会回退到 hsv）',
      lines: ['     → "omnishotcut.ckpt" 指到权重文件，或设 DSH_OSM_CKPT'],
    });
  } else {
    const st = await stat(osm.ckpt) ?? null;
    if (!st) {
      out.push({
        name: 'ckpt', ok: false,
        detail: `权重不存在：${osm.ckpt}`,
        lines: ['     → 路径写错也会长这样（相对路径按**当前目录**解析，建议写绝对路径）'],
      });
    } else if (st.size <= MIN_CKPT_BYTES) {
      out.push({
        name: 'ckpt', ok: false,
        detail: `权重太小：${osm.ckpt} 只有 ${(st.size / 1048576).toFixed(1)} MB（要 > 100 MB）`,
        lines: ['     → 多半是没下完 / 下成了 Git LFS 指针文件，重下一次'],
      });
    } else {
      out.push({ name: 'ckpt', ok: true, detail: `权重：${osm.ckpt} (${(st.size / 1048576).toFixed(0)} MB)` });
    }
  }

  // ---- 桥脚本
  if (osm.bridgeExists) {
    out.push({ name: 'bridge', ok: true, detail: `Python 桥：${osm.bridge}` });
  } else {
    out.push({
      name: 'bridge', ok: false,
      detail: `Python 桥不在：${osm.bridge ?? '(未解析)'}`,
      lines: [
        '     → 用包里那份 src/storyboard/omnishotcut-bridge.py；',
        '       自定义的位置写进 "omnishotcut.bridge" 或 DSH_OSM_BRIDGE',
      ],
    });
  }

  return out;
}
