/**
 * detectors/omnishotcut.js — 注册表条目：模型后端 **OmniShotCut v1.5**（要 python + 权重）。
 *
 * 实现全在 `../omnishotcut.js`（适配器：桥协议、argv、JSON 解析、错误码）里。这里只做
 * **声明 + 懒加载**：注册表被 import 不等于适配器被求值 —— hsv 路径（绝大多数调用）
 * 不该为了"表里有一行"就把 spawn / 桥协议读进内存。三个函数各自 `await import()`，
 * 模块求值只有一次，代价就是第一次用到后端的那一下。
 *
 * 为什么这些开关在**这一项**里而不是在 pipeline 里：
 *   - `bypassStages`：OmniShotCut 已经逐帧给全量边界，`cuts.js` 阶段 1/2 再用只会在
 *     同一处重复加刀；
 *   - `minGap`：转场中点与相邻硬切点会贴在一起，0.08s（24fps 约 1.9 帧）内视为同一刀，
 *     `kind='transition'` 优先保留；
 *   - 两者都只在"这个后端"这一项上成立，写进表就不会在 pipeline 里长出字符串分支。
 */
/** 切点最小间隔（秒）：与 `../omnishotcut.js` 的 `OSM_MIN_GAP` 是同一个数（有测试盯着）。 */
const MIN_GAP = 0.08;

/** 懒取适配器：只在真正要用这个后端时求值。 */
const adapter = () => import('../omnishotcut.js');

export const omniShotCutDetector = {
  id: 'omnishotcut',
  label: 'OmniShotCut v1.5',
  /** 模型只给"边界在哪"，逐帧曲线仍要 HSV 给（清单/档位/闪光标签全靠它） */
  needsCurve: true,
  bypassStages: ['still-spikes'],
  minGap: MIN_GAP,

  /**
   * 配置解析 + 校验（缺 python / ckpt → `osm-not-configured`；桥不在 → `osm-bridge-missing`）。
   * 抛结构化错误，**绝不静默退回 hsv** —— 那会产出"看起来成功、cuts 却来自另一个后端"的结果。
   * @param {object} cfg `resolveDetectorConfig()` 的返回值
   * @returns {Promise<{python: string, bridge: string, ckpt: string, source: object}>}
   */
  async resolve(cfg) {
    return (await adapter()).resolve(cfg);
  },

  /**
   * 扫描：先跑 HSV 曲线（`opts.curve`），再跑桥，`cuts` 取桥的并补分数。
   * @param {object} opts `{ input, fps, start, end, env, curve, ...透传 }`
   * @returns {Promise<object>} 与 `scanShots()` 同形，外加 `transitions` / `osm`
   */
  async scan(opts = {}) {
    return (await adapter()).scan({ ...opts, minGap: MIN_GAP });
  },

  /** 自检三项（python / 权重 / 桥）+ 一行配置来源；`run` / `stat` 由 doctor 注入。 */
  async doctorChecks(ctx = {}) {
    return (await adapter()).doctorChecks(ctx);
  },
};
