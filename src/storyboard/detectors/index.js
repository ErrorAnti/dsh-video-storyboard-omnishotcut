/**
 * detectors/index.js — **切点后端注册表**。
 *
 * 以前 pipeline 里散着三处 `detector === 'omnishotcut'`：查配置、选扫描器、开关补刀阶段。
 * 接第三个模型时那三处都要动，而且必然会漏一处（漏了就是"看起来跑通了，cuts 却是别人给的"）。
 * 现在每个后端是表里的一项，pipeline 只做三件事：**查表 → 调 `scan` → 拼既有形状**。
 *
 * ## 一项长什么样
 *
 * ```js
 * {
 *   id: 'omnishotcut',             // 配置里写的那个名字（也是 cacheKey 的 detector 维）
 *   label: 'OmniShotCut v1.5',     // 只给人看
 *   needsCurve: true,              // 是否要 HSV 逐帧曲线（现役都 true：档位/闪光标签靠它）
 *   bypassStages: ['still-spikes', 'refine-bursts'],  // 要关掉的 cuts.js 补刀阶段
 *   minGap: 0.08,                  // 切点最小间隔，喂给后端自己的 dedupe（0 = 不二次去重）
 *   resolve(cfg),                  // 解析 + 校验配置；缺参数**抛**（不回退）
 *   scan(opts),                    // 真正的扫描：{ input, fps, start, end, env, curve }
 *   doctorChecks(ctx),             // 自检项 [{ name, ok, detail, lines? }]
 * }
 * ```
 *
 * ## 接第四个后端要改哪儿
 *
 * 1. 写桥（`src/storyboard/<name>-bridge.py`）；
 * 2. 写适配器（`src/storyboard/<name>.js`，导出 `resolve` / `scan` / `doctorChecks`）；
 * 3. 写 `detectors/<name>.js` 声明一项（见 omnishotcut 那份，二十来行）；
 * 4. 在本文件下面那两行 import 里加一行。
 *
 * pipeline / cuts.js / cache.js / doctor.mjs **一行都不用动** —— `DETECTOR_IDS`
 * 是从这张表里推出来的，配置校验、错误信息、"只认这几个"的清单全都跟着走。
 */
import { hsvDetector } from './hsv.js';
import { omniShotCutDetector } from './omnishotcut.js';

/**
 * 表本身。**顺序有意义**：它决定 `detector must be one of …` 报错里的列举顺序，
 * 以及"默认档"在文档里的位置（hsv 在前：零依赖、开箱即用）。
 */
const ENTRIES = [hsvDetector, omniShotCutDetector];

const BY_ID = new Map(ENTRIES.map((d) => [d.id, d]));

/** 认得的后端 id（冻结数组）。`user-config.js` 与 `bin/doctor.mjs` 都从这里取。 */
export const DETECTOR_IDS = Object.freeze(ENTRIES.map((d) => d.id));

/**
 * 查表。大小写不敏感（`resolveDetector()` 已经把配置压成小写，这里再兜一次人工传参）。
 * @param {string} id
 * @returns {object|null} 不认识就 `null` —— 由调用方决定报什么错（pipeline 报 `osm-unknown-detector`）
 */
export function getDetector(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return BY_ID.get(key) ?? null;
}

/** 表里的全部 id（拷贝，避免调用方 push 进来）。 */
export function detectorIds() {
  return [...DETECTOR_IDS];
}

/** 表里的全部条目（拷贝）。doctor / 文档生成用得上；pipeline 只走 `getDetector`。 */
export function detectors() {
  return [...ENTRIES];
}
