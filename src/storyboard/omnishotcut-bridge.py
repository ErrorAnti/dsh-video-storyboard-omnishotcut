#!/usr/bin/env python3
"""omnishotcut-bridge.py — 跑 OmniShotCut v1.5，把结果压成**一行 JSON** 交给 Node。

契约：`docs/omnishotcut-backend.md` §1（冻结，键名不许改）。

为什么要有这座桥：OmniShotCut 只有 Python 发行（torch + cv2 + ffmpeg-python），
Node 侧没有不重写模型的近路。桥只做三件事：

  1. 把模型吐的 `ranges`（帧号）与 `intra` 标签翻成**秒**（浮点，3 位）；
  2. 把「硬切」与「渐变转场」分开 —— 硬切给一个时间点，转场给区间 `[from,to]`；
  3. **出错也走 JSON、退出码恒 0**，Node 侧于是只有一条读结果的路。

## 为什么不把「每个 range 的起点」都当一刀

OmniShotCut 会把**转场本身**算成一段 range：A → 叠化 → B 实际是
`[A] [Dissolve] [B]` 三段（02b 夹具实测：`[[0,49],[49,72],[72,97],...]`，
标签 `General / Dissolve / General`）。若 `A|Dissolve` 与 `Dissolve|B` 两个边界
各算一刀，同一次叠化会出两刀，而且都不是转场的中点。判定规则因此是：

| range 标签 | 这一段的起点算不算刀 | 产出 |
|---|---|---|
| 非 `General`（Dissolve/Wipes/Push/Slide/Zoom/Fade/Doorway） | 不算 | 整段作为 `transitions` 的一项 `{from,to,label}` |
| `General`，且**前一段也是** `General` | 算 | 一个 `cuts_sec` 点 |
| `General`，但前一段是转场 | 不算 | 边界已由那段转场的中点代表 |
| `Padding`（解码补边） | 不算 | 整段忽略，两侧边界都不出刀 |

于是 6 个镜头 + 5 处叠化 = **5 刀**（全部落在叠化中点），
8 个硬切镜头 = **7 刀**（落在每个后镜头的第一帧）。

## 用法

```
python omnishotcut-bridge.py <video> --ckpt <path> [--start S] [--end E] [--mode default] [--overlap 10]
```

`--start/--end` 只用来**裁剪输出窗口**（实现上是整片跑完再筛），
JSON 里如实回显 `window:[start,end]`。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import warnings

warnings.filterwarnings("ignore")

GENERAL = "General"
PADDING = "Padding"
MAX_MSG = 400


def emit(obj):
    """stdout 的唯一出口：一行 JSON，ASCII 转义（Windows 控制台编码安全）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(code, message, t0):
    """失败也是一种结果：`ok:false` + 契约里的错误码，退出码仍然是 0。"""
    emit({
        "ok": False,
        "code": code,
        "message": str(message)[:MAX_MSG],
        "ms": int((time.time() - t0) * 1000),
    })
    return 0


def sec(frame, fps):
    """帧号 → 秒（3 位小数）。fps 不可信时按 0 处理，不抛。"""
    if not (fps > 0):
        return 0.0
    return round(float(frame) / float(fps), 3)


def probe_fps(path, osm_fps=None):
    """容器帧率。优先用 omnishotcut 自己的 `_video_fps`（avg_frame_rate），
    失败再退到 ffprobe（纯 stdlib，subprocess）。两条都不行才抛。"""
    if osm_fps is not None:
        try:
            return float(osm_fps(path))
        except Exception:
            pass
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=avg_frame_rate", "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, timeout=30,
    )
    lines = [x.strip() for x in (out.stdout or "").splitlines() if x.strip()]
    if not lines:
        raise RuntimeError(f"ffprobe 没给出帧率: {path}")
    num, _, den = lines[0].partition("/")
    value = float(num) / float(den or 1)
    if not (value > 0):
        raise RuntimeError(f"帧率无效: {lines[0]}")
    return value


def classify(ranges, labels):
    """ranges + intra 标签 → (cut_frames, cut_labels, transitions)。

    规则见模块 docstring 的表。返回的 transitions 仍是**帧号**，换算在调用处做。
    """
    cuts, cut_labels, transitions = [], [], []
    n = len(ranges)
    for j in range(n):
        label = labels[j] if j < len(labels) and labels[j] else GENERAL
        start_f = int(ranges[j][0])
        end_f = int(ranges[j][1])

        if label == PADDING:
            # 补边段是解码产物，不是镜头；它两侧的边界都不许出刀
            continue

        if label != GENERAL:
            # 这一段**就是**转场：给区间，边界不再另出刀
            transitions.append({"from_f": start_f, "to_f": end_f, "label": label})
            continue

        if j == 0:
            # 整片开头没有"前一段"，不可能是一刀
            continue

        prev = labels[j - 1] if j - 1 < len(labels) and labels[j - 1] else GENERAL
        if prev != GENERAL:
            # 上一个 range 是转场（或补边）：这个边界归那段转场
            continue

        cuts.append(start_f)
        cut_labels.append(label)

    return cuts, cut_labels, transitions


def main():
    ap = argparse.ArgumentParser(description="OmniShotCut v1.5 -> single-line JSON")
    ap.add_argument("input")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--start", type=float, default=None)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--mode", default="default", choices=["default", "clean_shot"])
    ap.add_argument("--overlap", type=int, default=10)
    a = ap.parse_args()

    t0 = time.time()

    if not os.path.isfile(a.input):
        return fail("decode", f"找不到视频: {a.input}", t0)
    if not os.path.isfile(a.ckpt):
        return fail("no-weights", a.ckpt, t0)

    try:
        import omnishotcut
        from omnishotcut.datasets.utils import _video_fps as osm_fps
    except Exception as e:  # noqa: BLE001
        return fail("no-package", f"{type(e).__name__}: {e}", t0)

    try:
        model = omnishotcut.load(a.ckpt)
    except Exception as e:  # noqa: BLE001
        return fail("load-failed", f"{type(e).__name__}: {e}", t0)

    try:
        fps = probe_fps(a.input, osm_fps)
    except Exception as e:  # noqa: BLE001
        return fail("decode", f"帧率探测失败: {type(e).__name__}: {e}", t0)

    try:
        out = model.inference(a.input, mode=a.mode, overlap=a.overlap)
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        # 模型自己解码（ffmpeg-python）。解不开是 decode，解开了但前向炸了是 infer-failed
        code = "decode" if ("failed to decode" in msg or "decoded 0 frames" in msg) else "infer-failed"
        return fail(code, msg, t0)

    if a.mode == "clean_shot":
        # clean_shot 只回 ranges，没有标签 —— 全部按 General 处理，转场自然为空
        ranges, intra = out, []
    else:
        ranges, intra, _inter = out

    ranges = [[int(r[0]), int(r[1])] for r in (ranges or [])]
    labels = [str(x) for x in intra] if intra else [GENERAL] * len(ranges)

    cut_frames, cut_labels, trans_frames = classify(ranges, labels)
    frames = int(ranges[-1][1]) if ranges else 0

    cuts_sec = [sec(f, fps) for f in cut_frames]
    transitions = [
        {"from": sec(t["from_f"], fps), "to": sec(t["to_f"], fps), "label": t["label"]}
        for t in trans_frames
    ]

    windowed = a.start is not None or a.end is not None
    lo = 0.0 if a.start is None else float(a.start)
    hi = None if a.end is None else float(a.end)
    if windowed:
        hi_f = float("inf") if hi is None else hi
        keep = [i for i, t in enumerate(cuts_sec) if lo <= t <= hi_f]
        cuts_sec = [cuts_sec[i] for i in keep]
        cut_labels = [cut_labels[i] for i in keep]
        # 转场按中点判是否落在窗口内 —— 与 Node 侧折叠成中点一刀的口径一致
        transitions = [
            t for t in transitions if lo <= (t["from"] + t["to"]) / 2.0 <= hi_f
        ]

    payload = {
        "ok": True,
        "fps": round(float(fps), 3),
        "frames": frames,
        "shots": len(ranges),
        "cuts_sec": cuts_sec,
        "transitions": transitions,
        # 契约外的**加法**字段：cuts_sec 每点对应的 intra 标签（Node 侧填 cut.label）。
        # 硬切按构造恒为 General，但如实带出比在 Node 侧硬编码更诚实。
        "labels": cut_labels,
        "mode": a.mode,
        "ms": int((time.time() - t0) * 1000),
    }
    if windowed:
        payload["window"] = [lo, hi]

    emit(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
