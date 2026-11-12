/**
 * detectors/hsv.js — 内置后端：HSV 逐帧曲线**自己就是**切点来源（零依赖，默认档）。
 *
 * 注册表里最轻的一项：没有外部进程、没有权重、没有要校验的路径，所以 `resolve()` 直接
 * 返回空对象，`scan()` 就是把 pipeline 递进来的那个曲线回调跑一遍。
 *
 * 为什么 `minGap: 0`：hsv 的近邻合并发生在 `scanShots` 内部（`capGap` / `scanGap`），
 * 注册表这一层**不再二次去重** —— 0 在这里的意思是"没有额外间隔"。
 *
 * 为什么 `bypassStages: []`：`cuts.js` 的阶段 1（极静补刀）与阶段 2（爆点细扫）本来就是
 * 给"看得见曲线、看不见 0.35s 以下快切"的 HSV 补刀的，这一路正是它们的用武之地。
 */
export const hsvDetector = {
  id: 'hsv',
  label: 'HSV built-in (scanShots)',
  /** 是否要 pipeline 造一条逐帧曲线给它（所有现役后端都是 true） */
  needsCurve: true,
  /** 要关掉的 cuts.js 补刀阶段（`still-spikes` / `refine-bursts`）—— 这一路一个都不关 */
  bypassStages: [],
  minGap: 0,

  /** 零依赖后端没有要校验的东西；显式返回空对象，调用方不用判 null。 */
  resolve() {
    return {};
  },

  /** `opts.curve` 由 pipeline 注入（它同时把 means / prints 留在了 pipeline 里）。 */
  scan(opts = {}) {
    return opts.curve();
  },

  /** 自检：hsv 永远绿，只说明"这条路不需要 python / 权重"以及怎么换成模型后端。 */
  doctorChecks({ sourceText } = {}) {
    return [{
      name: 'hsv',
      ok: true,
      detail: `detector=hsv（${sourceText ?? '内置默认'}）—— HSV 路径，不需要 python / 权重`,
      lines: [
        '     → 想换 OmniShotCut：~/.dsh/video.json 写',
        '       { "detector": "omnishotcut", "omnishotcut": {',
        '         "python": "D:/osm/.venv/Scripts/python.exe", "ckpt": "D:/osm/omnishotcut.ckpt" } }',
        '       （或设 DSH_VIDEO_DETECTOR / DSH_OSM_PYTHON / DSH_OSM_CKPT）',
      ],
    }];
  },
};
