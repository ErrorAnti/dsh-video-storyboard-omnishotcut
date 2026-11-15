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

## 设备（有卡走 CUDA、没卡走 CPU）

模型源码 `vendor/OmniShotCut-main/omnishotcut/engine.py` 有**两处写死** `.to("cuda")`
（L66 `load_model`、L266 `_windows_to_ranges`），既没有 device 参数也没有开关。
`vendor/` 是上游仓库、项目纪律不改它，所以设备选择只能在**调用侧**做：

| `DSH_OSM_DEVICE` | 行为 |
|---|---|
| `auto`（默认） | `torch.cuda.is_available()` 为真走 cuda，否则 cpu |
| `cpu` | 强制 cpu：给 `nn.Module.to` / `Tensor.to` 打**进程内**重定向补丁，把 `.to("cuda")` 翻成 `.to("cpu")` |
| `cuda` | 强制 cuda；**不可用就报错退出**（`device-unavailable`），绝不静默降级 |

CPU 时线程数默认 4（本机 4P+4E 上实测最快：8 线程更慢、bf16 慢 20 倍），
`DSH_OSM_THREADS` 可覆盖。选择结果**恒打一行 stderr**（`device=cpu threads=4 …`），
`doctor` 与用户排查看的就是这一行。

重定向补丁的做法照抄 `bench/slim/device_shim.py`（那一轮 CPU 验证用的同一套）：
只改"目标设备字符串"，不改结构、不改 dtype、不改算子 —— 实测 CPU 与 GPU 的**切点 0 帧差异**
（`bench/slim/REPORT.md`），每窗前向 0.755 s vs 0.07 s。

## 用法

```
python omnishotcut-bridge.py <video> --ckpt <path> [--start S] [--end E] [--mode default] [--overlap 10]
python omnishotcut-bridge.py --probe-device          # 只解析设备，一行 JSON（doctor 用）
```

`--start/--end` 只用来**裁剪输出窗口**（实现上是整片跑完再筛），
JSON 里如实回显 `window:[start,end]`。

**退出码**：推理路径恒 0（错误也走 JSON，契约 §1）；只有 `--probe-device` 在
"显式要 cuda 但不可用 / 取值非法"时返回 3 —— 那是自检探针，不是推理，退出码是给 doctor 看的。
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

DEVICE_ENV = "DSH_OSM_DEVICE"
THREADS_ENV = "DSH_OSM_THREADS"
DEVICE_CHOICES = ("auto", "cpu", "cuda")
# 4 是本机（4P+4E）实测最快的线程数：8 线程比 4 线程更慢，bf16 慢 20 倍。
DEFAULT_CPU_THREADS = 4


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


# ------------------------------------------------------------------ 设备选择 ----

class DeviceError(RuntimeError):
    """设备取值非法 / 显式指定但不可用。`code` 直接当桥的错误码用。

    单独一个异常类是为了让"用户配错了"和"模型跑炸了"在调用处能分开：
    前者要的是改环境变量，后者要的是看 traceback。
    """

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def requested_device():
    """环境变量原文归一化：空 → auto，大小写不敏感。"""
    return (os.environ.get(DEVICE_ENV) or "").strip().lower() or "auto"


def requested_threads():
    """CPU 线程数：默认 4，`DSH_OSM_THREADS` 覆盖；非法值当场抛（不猜）。"""
    raw = (os.environ.get(THREADS_ENV) or "").strip()
    if not raw:
        return DEFAULT_CPU_THREADS
    try:
        n = int(raw)
    except ValueError:
        raise DeviceError("threads-invalid", f"{THREADS_ENV}={raw!r} 不是整数")
    if n < 1:
        raise DeviceError("threads-invalid", f"{THREADS_ENV}={raw!r} 必须 ≥ 1")
    return n


def resolve_device(requested=None, cuda_available=None):
    """→ `(device, threads)`；`threads` 只在 cpu 时有值（cuda 走 torch 默认）。

    两个参数只给测试/探针留的注入口（`cuda_available` 用来在没有卡的机器上验策略），
    正常路径全都不传：取值来自 `DSH_OSM_DEVICE`，可用性来自 `torch.cuda.is_available()`。

    **显式 cuda 但不可用必须抛** —— 静默降级会让用户以为自己在跑显卡，实际在跑 CPU，
    120 s 的片子从 5.6 s 变成 24 s，还找不到原因。
    """
    req = (requested if requested is not None else requested_device()).strip().lower() or "auto"
    if req not in DEVICE_CHOICES:
        raise DeviceError(
            "device-invalid",
            f"{DEVICE_ENV}={req!r} 不认识，只认 {' / '.join(DEVICE_CHOICES)}",
        )

    import torch  # 延迟到这儿：`--help` 不该为了打印用法去加载 2 GB 的库

    if cuda_available is None:
        cuda_available = bool(torch.cuda.is_available())

    if req == "cuda" and not cuda_available:
        raise DeviceError(
            "device-unavailable",
            f"{DEVICE_ENV}=cuda，但 torch {torch.__version__} 看不到可用显卡。"
            "修法：① 装 CUDA 版 torch（plugin/scripts/install-omnishotcut.ps1）；"
            f"② 或把 {DEVICE_ENV} 设成 auto / cpu。不会静默降级。",
        )

    device = "cuda" if (req == "cuda" or (req == "auto" and cuda_available)) else "cpu"
    return device, (requested_threads() if device == "cpu" else None)


def install_cpu_shim():
    """把 vendor 里写死的 `.to("cuda")` 重定向到 cpu —— **只影响本进程**。

    做法照抄 `bench/slim/device_shim.py`：包一层 `nn.Module.to` / `Tensor.to`，
    只翻译"目标设备字符串"，其余参数（dtype、copy、非阻塞…）原样透传。
    vendor 全库只有 engine.py:66 / :266 两处 `.to("cuda")`，没有 `.cuda()` 调用，
    也没有别处硬编码设备（其余 device 都从 tensor 自身推导），所以包这两个方法就够。

    为什么不在 vendor 里加参数：那是上游仓库，改了就再也拉不动上游更新，
    而且本项目纪律明令不改 `vendor/`。monkey-patch 的代价是"只对当前进程有效"，
    这恰好是我们要的边界。
    """
    import torch

    if getattr(torch, "_dsh_osm_cpu_shim", False):
        return  # 幂等：重复调用不叠层
    orig_module_to = torch.nn.Module.to
    orig_tensor_to = torch.Tensor.to

    def redirect(dev):
        if isinstance(dev, str):
            return "cpu" if dev.startswith("cuda") else dev
        if isinstance(dev, torch.device) and dev.type == "cuda":
            return torch.device("cpu")
        return dev

    def fix(args, kwargs):
        args = list(args)
        if args and isinstance(args[0], (str, torch.device)):
            args[0] = redirect(args[0])
        if "device" in kwargs:
            kwargs = dict(kwargs)
            kwargs["device"] = redirect(kwargs["device"])
        return tuple(args), kwargs

    def module_to(self, *args, **kwargs):
        args, kwargs = fix(args, kwargs)
        return orig_module_to(self, *args, **kwargs)

    def tensor_to(self, *args, **kwargs):
        args, kwargs = fix(args, kwargs)
        return orig_tensor_to(self, *args, **kwargs)

    torch.nn.Module.to = module_to
    torch.Tensor.to = tensor_to
    torch._dsh_osm_cpu_shim = True


def torch_flavor(version=None, cuda_version=None):
    """torch 版本串里的本地标记（`+cpu` / `+cu128`）。doctor 直接印这个。"""
    import torch
    v = torch.__version__ if version is None else version
    cuda_v = torch.version.cuda if cuda_version is None else cuda_version
    if "+" in v:
        return v
    if cuda_v:
        return f"{v}+cu{cuda_v.replace('.', '')}"
    return f"{v}+cpu"


def probe_device():
    """`--probe-device`：只解析设备、一行 JSON、不改任何全局状态。

    为什么走桥而不是让 doctor 自己拼一条 `python -c`：设备策略只有一份（就是上面
    `resolve_device`），doctor 读桥的结论才不会出现"自检说 cuda、真跑却 cpu"。
    """
    try:
        device, threads = resolve_device()
    except DeviceError as e:
        emit({
            "ok": False,
            "code": e.code,
            "message": str(e)[:MAX_MSG],
            "requested": requested_device(),
        })
        return 3

    import torch
    if device == "cpu" and threads:
        torch.set_num_threads(int(threads))

    try:
        import torchvision
        tv = torchvision.__version__
    except Exception:  # noqa: BLE001 — 缺 torchvision 是另一件事，不拦设备结论
        tv = None

    cuda_ok = bool(torch.cuda.is_available())
    emit({
        "ok": True,
        "requested": requested_device(),
        "device": device,
        "threads": int(torch.get_num_threads()),
        "torch": torch.__version__,
        "flavor": torch_flavor(),
        "torchvision": tv,
        "cudaAvailable": cuda_ok,
        "cudaVersion": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0) if cuda_ok else None,
    })
    return 0


def log_device(device, threads):
    """一行 stderr：`device=cpu threads=4 torch=2.11.0+cpu requested=auto`。

    固定格式是给 `doctor` 和用户 grep 用的，键名不许改（`docs` 里也是这么写的）。
    **纯 ASCII**：Windows 控制台默认 GBK，中文写 stderr 会变乱码；中文原因走 stdout 的 JSON。
    """
    import torch
    sys.stderr.write(
        "omnishotcut-bridge: device=%s threads=%d torch=%s requested=%s\n"
        % (device, int(torch.get_num_threads()), torch.__version__, requested_device())
    )
    sys.stderr.flush()


# 设备类错误的 stderr 一句话（ASCII）——中文原因在 stdout 的 JSON 里。
DEVICE_HINTS = {
    "device-unavailable": "torch cannot see a CUDA device; install CUDA torch or set DSH_OSM_DEVICE=auto|cpu",
    "device-invalid": "DSH_OSM_DEVICE must be one of auto|cpu|cuda",
    "threads-invalid": "DSH_OSM_THREADS must be a positive integer",
}


def log_device_error(err):
    """stderr 那一行（ASCII）；完整中文原因已经在 stdout 的 JSON 里。"""
    sys.stderr.write(
        "omnishotcut-bridge: %s requested=%s — %s\n"
        % (err.code, requested_device(), DEVICE_HINTS.get(err.code, "see JSON on stdout"))
    )
    sys.stderr.flush()


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
    ap.add_argument("input", nargs="?", help="视频路径（--probe-device 时可省）")
    ap.add_argument("--ckpt", default=None, help="权重路径（--probe-device 时可省）")
    ap.add_argument("--start", type=float, default=None)
    ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--mode", default="default", choices=["default", "clean_shot"])
    ap.add_argument("--overlap", type=int, default=10)
    ap.add_argument("--probe-device", action="store_true",
                    help="只解析设备选择并打印一行 JSON（doctor 用），不加载模型")
    a = ap.parse_args()

    t0 = time.time()

    if a.probe_device:
        return probe_device()
    if not a.input:
        return fail("usage", "缺少 <video> 位置参数", t0)
    if not a.ckpt:
        return fail("usage", "--ckpt 必填", t0)

    if not os.path.isfile(a.input):
        return fail("decode", f"找不到视频: {a.input}", t0)
    if not os.path.isfile(a.ckpt):
        return fail("no-weights", a.ckpt, t0)

    # 设备必须在第一次前向之前定下来：`.to("cuda")` 的补丁装晚了就没用了。
    try:
        device, threads = resolve_device()
    except DeviceError as e:
        log_device_error(e)
        return fail(e.code, str(e), t0)

    import torch
    if device == "cpu":
        install_cpu_shim()
        if threads:
            torch.set_num_threads(int(threads))
    log_device(device, threads)

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
        # 契约外的**加法**字段：这一次真跑在哪个设备上（cuda / cpu），
        # 排查"我明明有卡怎么这么慢"时先看它，不用翻 stderr。
        "device": device,
        "ms": int((time.time() - t0) * 1000),
    }
    if windowed:
        payload["window"] = [lo, hi]

    emit(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
