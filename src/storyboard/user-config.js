/**
 * user-config.js — 核心读取 ~/.dsh/video.json 的轻量入口。
 *
 * 设置页有自己的一份读写层（settings/config.js）；核心模块不能反过来依赖设置页，
 * 否则 settings -> asr -> core 的圈会绕回来。这里只读、只关心路径类字段。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function videoConfigPath(env = process.env) {
  return join(dshHome(env), 'video.json');
}

/** 坏文件/非对象都按空配置处理；核心不应该因为设置文件损坏而拒绝工作。 */
export function readVideoFile(env = process.env) {
  const path = videoConfigPath(env);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function configuredText(data, key) {
  const value = data && data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 按 `"a.b.c"` 路径读一个数字；不存在/非数字/越界都返回 null。
 * 嵌套路径是为了 `storyboard.cutFloor` 这种分组字段（和 `storyboard.auto` 同一层）。
 */
export function configuredNumber(data, path, { min = -Infinity, max = Infinity } = {}) {
  const raw = String(path).split('.')
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** 读一个**对象段**（`omnishotcut` / `ocr` 这种）；不是对象就返回 `{}`，调用方不必再判类型。 */
export function configuredSection(data, key) {
  const value = data && data[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/* ---------------------------------------------------------------- 检测器后端 ----
 * `hsv`（默认，零依赖）与 `omnishotcut`（模型后端，要 python + 权重）。
 *
 * 这一段放在 user-config.js 而不是 pipeline.js：doctor.mjs 也要问同一句
 * "这台机器上配的是哪个后端、缺什么"，两处各读一遍必然漂移。
 *
 * ```json
 * // ~/.dsh/video.json
 * {
 *   "detector": "omnishotcut",
 *   "omnishotcut": {
 *     "python": "D:/osm/.venv/Scripts/python.exe",
 *     "ckpt":   "D:/osm/omnishotcut-v1.5.pt",
 *     "bridge": "D:/osm/omnishotcut-bridge.py"   // 省略 = 用包里那份
 *   }
 * }
 * ```
 *
 * 优先级一律是 **显式传参 > 环境变量 > video.json > 内置默认**（与 asr.js 同一条规矩）：
 * 桌面版宿主读不到 `setx` 设的变量，文件是更可靠的那一层，但 CI / 一次性实验要能临时压过它。
 */

/** `hsv` | `omnishotcut` —— 认得的后端 id。 */
export const DETECTOR_IDS = Object.freeze(['hsv', 'omnishotcut']);

/** 后端的四个开关对应的环境变量名（doctor 报错时要照着念给用户）。 */
export const DETECTOR_ENV = Object.freeze({
  detector: 'DSH_VIDEO_DETECTOR',
  python: 'DSH_OSM_PYTHON',
  bridge: 'DSH_OSM_BRIDGE',
  ckpt: 'DSH_OSM_CKPT',
});

/**
 * 包内自带的 Python 桥（契约 §1 的文件：`src/storyboard/omnishotcut-bridge.py`）。
 * 配置里没写 `bridge` 就用它 —— 桥是**跟着插件发**的，不该逼用户去抄一个路径。
 */
export const DEFAULT_OSM_BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'omnishotcut-bridge.py');

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * `~/...` 展开成 $DSH_HOME，相对路径按 cwd 解析。
 *
 * 不做这件事的代价：用户按 README 写 `"ckpt": "~/osm/model.pt"`，
 * 于是 spawn 报 `ENOENT: ~/osm/model.pt` —— 看起来像"权重没下载"，其实是路径没展开。
 */
export function expandConfigPath(raw, env = process.env) {
  const text = nonEmpty(raw);
  if (!text) return '';
  if (/^~[/\\]/.test(text)) return join(dshHome(env), text.slice(2));
  if (text === '~') return dshHome(env);
  return isAbsolute(text) ? text : resolve(text);
}

/** @returns {{detector: string, source: 'arg'|'env'|'file'|'default'}} */
export function resolveDetector({ detector, data = readVideoFile(), env = process.env } = {}) {
  const fromArg = nonEmpty(detector);
  const fromEnv = nonEmpty(env[DETECTOR_ENV.detector]);
  const fromFile = configuredText(data, 'detector');
  const picked = fromArg || fromEnv || fromFile || 'hsv';
  return {
    detector: picked.toLowerCase(),
    source: fromArg ? 'arg' : fromEnv ? 'env' : fromFile ? 'file' : 'default',
  };
}

/**
 * 解析 `omnishotcut` 段。**不判断"配全了没有"** —— 那是调用方的事（只有真要用这个后端时才该报错），
 * 这里只负责"能解析到什么"，并把 `missing` 列出来，让错误信息能指名道姓。
 *
 * @returns {{python: string|null, bridge: string|null, ckpt: string|null,
 *   bridgeExists: boolean, source: {python: string, bridge: string, ckpt: string}, missing: string[]}}
 */
export function resolveOmniShotCut({ omnishotcut, data = readVideoFile(), env = process.env } = {}) {
  const explicit = omnishotcut && typeof omnishotcut === 'object' ? omnishotcut : {};
  const file = configuredSection(data, 'omnishotcut');
  const pick = (key, envKey) => {
    const fromArg = nonEmpty(explicit[key]);
    if (fromArg) return { value: fromArg, source: 'arg' };
    const fromEnv = nonEmpty(env[envKey]);
    if (fromEnv) return { value: fromEnv, source: 'env' };
    const fromFile = nonEmpty(file[key]);
    if (fromFile) return { value: fromFile, source: 'file' };
    return { value: '', source: 'default' };
  };

  const python = pick('python', DETECTOR_ENV.python);
  const ckpt = pick('ckpt', DETECTOR_ENV.ckpt);
  const bridge = pick('bridge', DETECTOR_ENV.bridge);
  // python 可能是裸名字（靠 PATH 找），**不能**当路径展开：'python' 展开成 CWD\python 就永远跑不起来。
  const pythonPath = python.value || '';
  const bridgePath = bridge.value ? expandConfigPath(bridge.value, env) : DEFAULT_OSM_BRIDGE;
  const ckptPath = ckpt.value ? expandConfigPath(ckpt.value, env) : '';
  return {
    python: pythonPath || null,
    bridge: bridgePath || null,
    ckpt: ckptPath || null,
    bridgeExists: Boolean(bridgePath) && existsSync(bridgePath),
    source: { python: python.source, bridge: bridge.source, ckpt: ckpt.source },
    missing: [...(pythonPath ? [] : ['python']), ...(ckptPath ? [] : ['ckpt'])],
  };
}

/** 一次问全：后端 id + 它要的东西（pipeline / doctor 共用这一个入口）。 */
export function resolveDetectorConfig({ detector, omnishotcut, data, env = process.env } = {}) {
  const file = data ?? readVideoFile(env);
  const { detector: id, source } = resolveDetector({ detector, data: file, env });
  return {
    detector: id,
    source,
    configPath: videoConfigPath(env),
    omnishotcut: resolveOmniShotCut({ omnishotcut, data: file, env }),
  };
}
