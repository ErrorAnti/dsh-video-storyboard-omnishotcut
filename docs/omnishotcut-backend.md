# OmniShotCut 后端接入契约（v1，冻结）

> 角色：本次改动的**唯一接口依据**。两个实施代理按本文写代码，不得单方面改名/改形状。
> 分支：`feat/omnishotcut`（已在 `dsh-video-storyboard` v0.7.4 的 clone 上创建）。

## 0. 目标（只要这三条）

1. 新增**可选**检测器后端 `omnishotcut`，默认仍是现有 HSV（零依赖路径不能被破坏）。
2. 切点来自 OmniShotCut；**逐帧分数曲线、`means`、`prints`、`longStats` 仍来自现有 HSV 扫描**（积分补帧、闪光标签、极静检测全靠它，OmniShotCut 不给连续信号）。
3. 每段渐变转场（OmniShotCut 会给 `[start,end]` + 标签）在 v1 里**折叠成中点一刀**，与现有"单点切点"模型保持一致；原始区间另存到 `transitions`，供清单展示。

## 1. Python 桥

文件：`src/storyboard/omnishotcut-bridge.py`

```
python omnishotcut-bridge.py <video> --ckpt <path> [--start S] [--end E] [--mode default] [--overlap 10]
```

- **stdout 只输出一行 JSON**（结果或错误），stderr 可自由打印日志。
- 成功：`{"ok":true,"fps":24.0,"frames":576,"shots":8,"cuts_sec":[3.0,6.0,...],"transitions":[{"from":3.0,"to":4.0,"label":"Dissolve"}],"ms":1234}`
- 失败：`{"ok":false,"code":"no-weights|no-package|load-failed|infer-failed|decode","message":"...","ms":0}`，退出码 0（错误也是一种结果）。
- 时间单位**一律秒**（浮点，保留 3 位）。帧号由 Node 侧用 fps 换算。
- `--start/--end`：只跑窗口时使用；实现上允许「整片跑完再裁剪」，但必须在 JSON 里如实回显 `window:[start,end]`。
- 纯 stdlib + omnishotcut + torch；不要引入 argparse 之外的新依赖。

## 2. Node 适配器

文件：`src/storyboard/omnishotcut.js`

```js
export const OSM_DETECTOR_ID = 'omnishotcut-v1.5';

// 只负责「拿到 OmniShotCut 的结果」，不做任何融合
export async function runOmniShotCut({
  input, fps, start = 0, end,          // 秒
  python, bridge, ckpt,                 // 绝对路径（由调用方解析）
  mode = 'default', overlap = 10,
  signal, timeoutMs = 600000,
  exec = null,                          // 注入点：测试可传假的实现
}) -> {
  cuts: [{ t, score, kind: 'cut'|'transition', label?, from?, to? }],
  transitions: [{ from, to, label }],   // 秒
  fps, frames, shots, ms,
}
```

规则：
- 每个 `transitions` 项产生**一个** `cuts` 项，`t = (from+to)/2`，`kind='transition'`，`label` 原样带出。
- `cuts_sec` 里的点产生 `kind='cut'`，`label` 取 OmniShotCut 的 `intra` 标签（若可用）。
- 进程失败 → 抛 `Error`，`err.code` 用桥返回的 `code`；**绝不静默降级**（调用方负责决定回退）。
- 用 `node:child_process.spawn`，`windowsHide: true`，超时杀进程。

### 2.1 融合入口（给 pipeline 用）

```js
export async function hybridScan({
  input, fps, start, end,
  hsvScan,               // 必传：一个 (opts)=>Promise<scanShots结果> 的函数（依赖注入，便于测试）
  python, bridge, ckpt, signal, timeoutMs,
}) -> {
  // 形状与 scanShots() 完全一致，外加两个字段
  cuts, stats, longStats, frames, threshold, degraded, summary,
  means, prints, bars, scoring,          // ← 全部来自 hsvScan，逐字段透传
  transitions,                            // ← OmniShotCut 的原始转场区间
  osm: { ms, shots, fps },
  scoring: { ...hsv.scoring, detector: OSM_DETECTOR_ID, cutSource: 'omnishotcut' },
}
```

- `cuts` 取 OmniShotCut 的（**覆盖** hsv 的），排序去重（相距 < 0.08s 视为同一刀，保留 `kind='transition'` 优先）。
- 其余字段**原样**从 hsv 结果透传，一个都不许改（`tiers.integralMarks` / `flash.tagCuts` 依赖它们）。
- `hybridScan` 内部：先 `hsvScan` 再跑 OmniShotCut（并行也可以，但错误要能归属到具体哪一路）。

## 3. pipeline 接线

`runStoryboard(opts)` 新增：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `detector` | `'hsv' \| 'omnishotcut'` | `'hsv'` | 配置文件 `~/.dsh/video.json` 的 `detector`，环境变量 `DSH_VIDEO_DETECTOR` 优先 |
| `omnishotcut` | `{python, bridge, ckpt}` | 由配置/环境解析 | 缺任一字段且 `detector='omnishotcut'` → 抛结构化错误，**不静默回退** |

- `detector==='omnishotcut'` 时：`scan` 来自 `hybridScan`；`scanMode` 仍然决定 HSV 曲线的口径（默认 `mc`）。
- 缓存：`cacheKey` 必须并入 `detector` 与 `ckpt` 的 sha256（没有 sha256 就用 mtime+size）；**不加这条会出现"换了后端却命中旧缓存"**。
- `cuts.js` 的 `resolveCuts` 新增两个开关，`omnishotcut` 时都传 `false`：
  - `allowStillSpikes`（阶段 1 极静补刀）
  - `allowRefineBursts`（阶段 2 爆点细扫）
  理由：OmniShotCut 已经逐帧给全量边界，这两阶段是给 HSV 曲线补刀的，再用只会重复加刀。
- 阶段 3（丐中丐合并）、阶段 4（打标签）**保持开启**。

## 4. 清单展示

`format.js`：当 `scan.transitions?.length` 时，在现有 `plan:` 行后加一行
`grad: 5 transition(s) — dissolve 3 / fade 1 / wipe 1`（按 label 归并计数）。
单元格若正好是某段转场的中点，可在该行尾加 ` (transition)`。**不新增行数**：一行搞定。

## 5. 验收（必须真跑，写进报告）

1. `node scripts/check-syntax.mjs` 全绿。
2. `node --test`（`test/` 下现有用例）全绿。
3. 用夹具 `01-hardcut / 04-flash / 07-fastcut / 02b-dissolve1s` 跑 `bin/storyboard.mjs`：
   - `--detector hsv` 与 `--detector omnishotcut` 都必须**正常出图 + 出清单**；
   - 后者清单里出现 `grad:` 行；
   - 两次运行的 `cuts=N` 与格子数写进报告。
4. 缓存串味测试：先用 hsv 跑一次，再切 omnishotcut 跑同一文件，**必须重新扫描**（日志/耗时能看出来），不得命中旧缓存。

## 6. 边界

- 不改 `bin/storyboard.mjs` 的参数表（内部走配置文件/环境变量即可；CLI flag 可选，不是必须）。
- **v2 起 `tiers.js` 参与**：`framesFromBounds` 接受 `transitions`，转场自己占一段（`via:'transition'`），
  档位由 `applyTransitionBoost` 兜到至少 1/4（见 §7）。除此之外不动 `tiers.js`。
- 不打包权重、不写死绝对路径；权重路径由配置/环境给出。
- 不引入 npm 新依赖（Node 侧只用 `node:child_process`）。

## 7. v2：转场段占独立小格（已落地）

v1 把转场折叠成一个中点切点，转场宽度只进了清单文字。v2 把它变成结构：

| 位置 | 行为 |
|---|---|
| `tiers.framesFromBounds({transitions})` | 转场的 `from`/`to` 都成为段边界，段标签 `via:'transition'` |
| `pipeline` 的 `segCuts` | **丢掉落在转场内部的中点切点**（否则会把转场劈成两半、标签永远打不上） |
| `tiers.applyTransitionBoost(tiers, segs)` | 转场段档位 `max(原档位, 4)` —— 至少 1/4，但周围更细时保持更细 |
| `pipeline.fillGaps` | **不动含转场段的图**（它会重建分段、把 `via` 抹掉）；代价是那张图填充率低一点 |
| 密度曲线 `levelCurve` | 仍只用中点切点，**不吃**转场边界（否则一段转场会把左右镜头一起压小） |

实测（`02b-dissolve1s.mp4`，6 镜头 / 5 段 1 s 叠化）：
v1 = 5 帧（4 格）→ v2 = **11 帧 / 1 张 / 档位 1/2×1 1/3×5 1/4×5，填充 84.4%**。

## 8. 后续两项（P1/P2，已落地）

### 8.1 转场型白闪：唯一允许删刀的地方

`cuts.js` 阶段 5：`kind === 'transition'` **且** `type === 'flash'` 的切点才删。

- 只有 osm 会产出 `kind:'transition'`，所以 **HSV 路径行为逐位不变**；
- 白闪**转场**（画面真的换了）的 `nv` 很大，命中不了 `flash` 判据；
- 删除会留 `trace: drop-flash-transition:N->M`，清单能解释"为什么少了一刀"；
- 删了切点，**它的转场区间也要一起失效**（`keptTransitions`），否则 `framesFromBounds` 会照着那段再切一个 0.08 秒的转场格。

实测：`04-flash` 6 刀 → **5 刀**（与真值一致）。

### 8.2 切点分数补偿

`fillCutsScore(cuts, hsv.stats)`：用 HSV 曲线在切点 ±0.12 s 的**峰值**填 `score`
（窗口内没采样就退到最近一帧）。目的只有一个 —— 让 `cuts.js` 阶段 3 的
`suppressClose`「保留分数更高的一刀」不再退化成"保留第一个"。

### 8.3 一个必须知道的缓存陷阱

缓存里的 `printPack` 是 **8 fps** 打包指纹，而 `means` / `stats` 是按真实帧存的。
打标签时若用 `fps=24` 去索引 8 fps 的指纹，证据全错位 —— 表现为「同一段视频第一次 5 刀、
第二次 6 刀，标签从 hardcut 变成 dissolve」。

修法：`cuts.js` 用 `printFps` 作 `tagFps`；`flash.js` 在 `means.length !== prints.length`
时从指纹现算亮度；缓存补存按指纹帧率压过的 `scores`。详见项目仓库
`docs/incidents/缓存命中的指纹是-8fps.md`。
