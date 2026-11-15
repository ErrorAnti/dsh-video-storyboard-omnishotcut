# 安装 OmniShotCut（设备自适应：有卡走 CUDA、没卡走 CPU）

> 文档角色：OmniShotCut 后端的安装与设备选择。
> 唯一负责：怎么把 torch 装成这台机器该有的那一版、`DSH_OSM_DEVICE` / `DSH_OSM_THREADS` 的语义、装坏了怎么恢复。
> 不负责：插件整体安装（见 `docs/INSTALL.zh.md`）、桥的输出契约（见 `docs/omnishotcut-backend.md`）、判分口径（见 `docs/architecture/判分口径.md`）。

## 0. 一句话

```powershell
cd <仓库根>
pwsh -File plugin\scripts\install-omnishotcut.ps1      # 有卡 → cu128；没卡 → cpu
node bin\doctor.mjs                                    # 第 5 节会印 device=cuda 或 device=cpu
```

装错版本的代价不是"跑不起来"，而是**悄悄跑慢 4 倍**（CPU 版 torch 在有卡的机器上一样能跑，
只是 `torch.cuda.is_available()` 是 `False`，没人会注意）。所以设备选择是**显式**的，
`doctor` 会把它印出来，桥每次启动也往 stderr 打一行。

## 1. 两种机器，两条命令

### 1.1 有 N 卡（Windows + 驱动正常，`nvidia-smi` 能报出型号）

```powershell
cd <仓库根>
pwsh -File plugin\scripts\install-omnishotcut.ps1
# 等价于：-Cuda cu128，venv = env\venv
```

装的是 `torch 2.11.0+cu128` / `torchvision 0.26.0+cu128`，索引 `https://download.pytorch.org/whl/cu128`。

### 1.2 没 N 卡（或就想跑 CPU）

```powershell
cd <仓库根>
pwsh -File plugin\scripts\install-omnishotcut.ps1 -Cpu -Venv env\venv-cpu
# 想省体积再加 -Minimal
```

装的是 `torch 2.15.0+cpu` / `torchvision 0.29.2+cpu`（索引 `.../whl/cpu`，版本由索引当前提供的最新版决定）。

### 1.3 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| `-Cpu` | 关 | 强制 CPU 版 torch（与 `-Cuda` 互斥） |
| `-Cuda <ver>` | `cu128` | 强制 CUDA 版，`ver` 是 pytorch 索引里的目录名（`cu128` / `cu126` / `cu124`…） |
| `-Venv <path>` | `env\venv` | 目标 venv；相对路径按**仓库根**解析，不存在会自动建 |
| `-Minimal` | 关 | 只装最小依赖集（见 §6） |
| `-Force` | 关 | 允许"把 CUDA 版换成 CPU 版"这种降级（见 §5） |

退出码：`0` 成功 / `1` 失败（pip 报错等）/ `2` 被安全条款拦下（需要 `-Force`）。

## 2. 体积与耗时（本机实测，RTX 3050 Laptop + 4P+4E）

| | CUDA 版 | CPU 版 |
|---|---|---|
| venv 体积 | **4,984 MB** | **797 MB**（torch 2.11.0+cpu）/ 858 MB（torch 2.15.0+cpu） |
| 每窗前向（`max_process_window_length` 帧） | **0.07 s** | **0.755 s** |
| 120 s 的片子（2880 帧，32 窗） | **≈5.6 s** | **≈24 s** |
| 切点差异 | — | **0 帧**（逐位相同） |

"0 帧差异"不是估计：`bench/slim/REPORT.md` 里 CPU/GPU 两路跑同一批夹具，`cuts_sec` 与
`transitions` 完全相同；本次改造后又在插件管线上复核了一遍 —— `02b-dissolve1s` 用
`DSH_OSM_DEVICE=cuda` 与 `=cpu` 各出一张板，PNG 的 sha256 与 manifest 都**逐字节相同**
（`153847DB…647A`，见 §7 的复核命令）。

CPU 侧的线程数是 4 最快（8 线程反而更慢，`bfloat16` 慢 20 倍），所以默认就是 4。

## 3. `DSH_OSM_DEVICE`：设备怎么选

| 取值 | 行为 |
|---|---|
| `auto`（默认） | `torch.cuda.is_available()` 为真 → `cuda`，否则 `cpu` |
| `cpu` | 强制 CPU。即使有卡也走 CPU —— 这就是"模拟无卡"验 CPU 路径的方式 |
| `cuda` | 强制 CUDA。**不可用就报错退出**（错误码 `device-unavailable`），不静默降级 |

为什么要允许"有卡还强制 cpu"：CPU 与 GPU 的切点必须能互相复现（上面那个 0 帧差异就是这么验的），
不然"CPU 上出问题"永远只能靠猜。

为什么 `cuda` 不可用时必须报错：静默降级 = 用户以为在跑显卡、实际在跑 CPU，
120 s 的片子 5.6 s 变 24 s，还查不出原因。报错文案里直接写了修法。

### 3.1 模型源码写死了 `.to("cuda")`，怎么兜住的

`vendor/OmniShotCut-main/omnishotcut/engine.py` 有两处硬编码（`:66` `load_model`、`:266`
`_windows_to_ranges`），既没有 device 参数也没有开关；`vendor/` 是上游仓库，本项目不改它。

桥（`plugin/src/storyboard/omnishotcut-bridge.py`）因此在**自己进程内**给
`torch.nn.Module.to` / `torch.Tensor.to` 套了一层：把任何指向 `cuda` 的设备参数翻成 `cpu`，
其余参数（dtype / copy / 非阻塞）原样透传。做法与 `bench/slim/device_shim.py` 一致。

- 只影响**本进程**：monkey-patch 不写文件、不碰环境变量，别的 Python 进程看不到；
- 只改"目标设备字符串"：模型结构、dtype、算子实现都没动，所以 CPU 测出来的就是这条真实推理路径；
- 只有 `device=cpu` 时才装（`cuda` 时保持原生行为）。

## 4. `DSH_OSM_THREADS`：CPU 线程数

| | 默认 | 说明 |
|---|---|---|
| `DSH_OSM_THREADS` | `4` | 只在 `device=cpu` 时生效；非法值（`0` / `abc` / `1.5`）报 `threads-invalid` |

4 是本机（4 性能核 + 4 能效核，i5-12450H）实测最快的值。每窗前向：

| 线程数 | 01-hardcut | 04-flash | 02b-dissolve1s |
|---|---|---|---|
| **4** | **762 ms** | **755 ms** | **756 ms** |
| 8（torch 默认） | 842 ms | 864 ms | 820 ms |
| 6 | 951 ms | 952 ms | 963 ms |
| 12 | 跑不完单轮（>60 s），未计入 | | |

4 比默认（8）快 9–14%，6 比 4 慢 22–27%。原因是 4 线程时调度器把活留在 4 个 P-core 上，
8/6 会摊到 E-core（IPC 低）甚至跨簇。换机器可以自己试，改这个环境变量即可，不用重装。

## 5. 安全条款（脚本为什么会在动手前停下）

历史事故（`docs/incidents/torch-被-CPU-版覆盖.md`）：`pip install -e vendor/OmniShotCut-main`
读到 `torch>=2.0`，从 PyPI 默认索引解析成 **CPU wheel**，把已有的 `2.11.0+cu128` 覆盖掉。
之后 `pip list` 里版本号还对得上（`+cu128` 后缀没了），推理报 "Torch not compiled with CUDA enabled"。

脚本里的三条硬规矩：

1. **目标 venv 里已是 CUDA 版 torch，而这次要装 CPU 版 → 打印警告 + 要求 `-Force`**，退出码 2。
   要降级就显式加 `-Force`，要验 CPU 路径就换个 venv（`-Venv env\venv-cpu`）。
2. **`omnishotcut` 一律 `pip install -e <vendor> --no-deps`**，绝不让它去解析 torch 依赖。
3. **torch / torchvision 只从 `download.pytorch.org/whl/<flavor>` 装**，且 flavor 变化时自动加
   `--force-reinstall`（同名同版本号、只有 `+cu128`/`+cpu` 不同时，pip 会认为"已满足"而跳过）。

另外：安全检查在**任何写操作之前**（`pip` 自我升级也只发生在"这次刚建出来的 venv"上），
所以拿已有 venv 试跑一次 `-Cpu` 不会动它一个字节。

## 6. 依赖集

最小依赖集（按 `vendor/OmniShotCut-main/omnishotcut/**` 的实际 import 审计：
`cv2` / `ffmpeg` / `numpy` / `PIL` / `packaging` / `huggingface_hub` / `torch` / `torchvision`）：

```
torch torchvision numpy opencv-python-headless ffmpeg-python pillow packaging huggingface_hub
```

不带 `-Minimal` 时多装上游 `requirements.txt` 里的轻量周边：`tqdm omegaconf imageio pandas`。

**明确不装**：`gradio` / `spaces`（`app.py` 的网页 UI）、`accelerate` / `transformers` /
`scikit-learn` / `matplotlib` / `tensorboard`（训练与评测栈）—— 这个后端只做推理，用不到。
要跑上游 `app.py` 自己补 `pip install gradio spaces`。

`opencv-python` 与 `opencv-python-headless` 会抢同一个 `cv2/` 目录，所以脚本发现已有 GUI 版时会
跳过 headless 那一个。

## 7. 怎么确认装对了

```powershell
cd <仓库根>
$py = "env\venv\Scripts\python.exe"

# ① 版本号 + 后缀（+cu128 / +cpu 才是"哪一版 wheel"的证据）
& $py -c "import torch;print(torch.__version__, torch.cuda.is_available())"
# 期望：2.11.0+cu128 True

# ② 桥自己的设备探针（和 doctor 用的是同一条路）
& $py plugin\src\storyboard\omnishotcut-bridge.py --probe-device
# {"ok":true,"requested":"auto","device":"cuda","threads":8,"torch":"2.11.0+cu128",...,"gpu":"NVIDIA GeForce RTX 3050 Laptop GPU"}

# ③ doctor（第 5 节）
cd plugin
$env:DSH_VIDEO_DETECTOR = 'omnishotcut'
node bin/doctor.mjs
```

doctor 里的样子（本机实测）：

```
  ✅ python: <仓库根>\env\venv\Scripts\python.exe — import omnishotcut ? (Python 3.14.6)
  ✅ device: cuda — torch 2.11.0+cu128, threads 8
     requested=auto  cudaAvailable=true  gpu=NVIDIA GeForce RTX 3050 Laptop GPU
     torchvision 0.26.0+cu128
```

显式 `cuda` 但不可用时是硬伤（退出码 1）：

```
  ❌ 设备不可用：DSH_OSM_DEVICE=cuda，但 torch 2.15.0+cpu 看不到可用显卡。修法：…
     → ① 装 CUDA 版 torch：plugin\scripts\install-omnishotcut.ps1（不带 -Cpu）
       ② 或把 DSH_OSM_DEVICE 设成 auto / cpu（显式 cuda 不会静默降级）
       ③ 驱动：nvidia-smi 能报出显卡型号才算有卡
```

桥每次真跑都会往 **stderr** 打一行（纯 ASCII，Windows 控制台不会乱码）：

```
omnishotcut-bridge: device=cpu threads=4 torch=2.11.0+cu128 requested=cpu
```

复核 CPU/GPU 切点一致（本次改造后跑过的那条，两个设备各给一个**全新**缓存目录，
否则第二次直接命中缓存、模型根本没跑）：

```powershell
cd plugin
$env:DSH_VIDEO_DETECTOR = 'omnishotcut'
$env:DSH_OSM_PYTHON = "<仓库根>\env\venv\Scripts\python.exe"
$env:DSH_OSM_CKPT   = "<仓库根>\models\omnishotcut_ckpt.pth"
$env:DSH_OSM_BRIDGE = "<仓库根>\plugin\src\storyboard\omnishotcut-bridge.py"

$env:DSH_OSM_DEVICE = 'cuda'; $env:DSH_VIDEO_CACHE_DIR = "..\temp\cache-cuda"
node bin/storyboard.mjs "..\fixtures\clips\02b-dissolve1s.mp4" --out "..\temp\board-cuda.png" --manifest "..\temp\board-cuda.json"

$env:DSH_OSM_DEVICE = 'cpu';  $env:DSH_VIDEO_CACHE_DIR = "..\temp\cache-cpu"
node bin/storyboard.mjs "..\fixtures\clips\02b-dissolve1s.mp4" --out "..\temp\board-cpu.png" --manifest "..\temp\board-cpu.json"

Get-FileHash ..\temp\board-cuda.png, ..\temp\board-cpu.png -Algorithm SHA256
# 两个 hash 必须一样；manifest 也应该逐字节相同
```

## 8. 装坏了怎么恢复（CUDA 版被 CPU 版顶掉）

症状：

```
AssertionError: Torch not compiled with CUDA enabled
RuntimeError: operator torchvision::nms does not exist
```

而 `pip list` 里 `torch` 版本号看着还对（`2.11.0`，`+cu128` 没了）。

**离线恢复（首选，`env/downloads/` 里常备这两个 wheel，不用重下 2.6 GB）**：

```powershell
cd <仓库根>
$py = "env\venv\Scripts\python.exe"
& $py -m pip install --no-index --no-deps --force-reinstall `
      "env\downloads\torch-2.11.0+cu128-cp314-cp314-win_amd64.whl"
& $py -m pip install --no-index --no-deps --force-reinstall `
      "env\downloads\torchvision-0.26.0+cu128-cp314-cp314-win_amd64.whl"
& $py -c "import torch,torchvision;print(torch.__version__,torchvision.__version__,torch.cuda.is_available())"
# 期望：2.11.0+cu128 0.26.0+cu128 True
```

**在线恢复（本地 wheel 丢了）**：

```powershell
& $py -m pip install --force-reinstall --index-url https://download.pytorch.org/whl/cu128 torch torchvision
```

**torchvision ABI 不匹配**（`operator torchvision::nms does not exist`）：torch 与 torchvision
必须**同代、同 flavor**。`pip install torchvision` 从 PyPI 拿到的是配 torch 2.15 的版本，
所以只能从同一个 `.../whl/cu128` 索引装；离线恢复时文件名必须保留 `+cu128` 后缀
（否则 pip 报 `Invalid wheel filename (wrong number of parts)`）。

**只是 venv 整个没了**：直接重跑 `pwsh -File plugin\scripts\install-omnishotcut.ps1`
（有卡）/ 加 `-Cpu`（没卡）。脚本会建 venv、装对 flavor、再用 `--no-deps` 挂上 `omnishotcut`。

## 9. 相关文件

| 文件 | 职责 |
|---|---|
| `plugin/scripts/install-omnishotcut.ps1` | 本安装器（flavor 选择 + 安全条款 + 依赖 + 报告） |
| `plugin/src/storyboard/omnishotcut-bridge.py` | 设备解析 `resolve_device()`、CPU 重定向补丁、`--probe-device` |
| `plugin/src/storyboard/omnishotcut.js` | `resolveDevice()` / `parseTorchFlavor()` / doctor 的 `device` 项 |
| `plugin/test/omnishotcut-device.test.mjs` | 设备解析与 doctor 设备项的判据 |
| `bench/slim/` | 当初的 CPU 对照实验（数字出处） |
| `docs/incidents/torch-被-CPU-版覆盖.md` | 事故记录（本文件 §5/§8 的来源） |
