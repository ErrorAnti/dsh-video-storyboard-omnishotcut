<#
.SYNOPSIS
  按机器自动装对版本的 OmniShotCut 后端（有 N 卡装 CUDA 版 torch，没有装 CPU 版）。

.DESCRIPTION
  这个脚本只做一件事：**让 torch 与这台机器的显卡对得上**，然后把 omnishotcut 装成
  editable（`--no-deps`，绝不让它去解析 torch 依赖）。其余依赖走最小集。

  为什么要有它（血泪，见 docs/incidents/torch-被-CPU-版覆盖.md）：
    `pip install -e vendor/OmniShotCut-main` 会读到 `torch>=2.0`，从 PyPI 默认索引
    解析成 **CPU wheel**，把已有的 `2.11.0+cu128` 悄悄覆盖掉 —— 之后推理直接
    "Torch not compiled with CUDA enabled"，而 `pip list` 里版本号还对得上。
    所以本脚本：
      1. torch / torchvision 只从 `download.pytorch.org/whl/<flavor>` 装；
      2. omnishotcut 一律 `--no-deps`；
      3. 目标 venv 里已是 CUDA 版 torch、而这次要装 CPU 版时 —— **要求 -Force**。

.PARAMETER Cpu
  强制 CPU 版（`+cpu`）。用于没有显卡的机器，或者"我就想验一遍 CPU 路径"。

.PARAMETER Cuda
  强制 CUDA 版，取值是 pytorch 索引里的 flavor 目录名（`cu128` 默认 / `cu126` / `cu124` …）。
  与 -Cpu 互斥。不写这个参数时**自动检测**：`nvidia-smi` 能报出显卡 → `cu128`，否则 `cpu`。

.PARAMETER Venv
  目标 venv 路径。相对路径按**仓库根**解析（默认 `env\venv`）。不存在会自动创建。

.PARAMETER Minimal
  只装最小依赖集（已按 vendor 源码的 import 审计过）：
    torch torchvision numpy opencv-python-headless ffmpeg-python pillow packaging huggingface_hub
  不带这个参数时会多装上游 `requirements.txt` 里的轻量周边（tqdm / omegaconf / imageio / pandas）。

.PARAMETER Force
  允许"把 CUDA 版 torch 换成 CPU 版"这种降级。没有它，脚本会在动手前停下（退出码 2）。

.EXAMPLE
  # 有卡机器（默认）：自动 cu128
  .\plugin\scripts\install-omnishotcut.ps1

.EXAMPLE
  # 没卡机器 / 想跑 CPU：临时目录里试一遍，不碰 env\venv
  .\plugin\scripts\install-omnishotcut.ps1 -Cpu -Venv env\venv-test -Minimal

.EXAMPLE
  # 真要把现有的 CUDA venv 降成 CPU（会重下 ~250 MB）
  .\plugin\scripts\install-omnishotcut.ps1 -Cpu -Force
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Cpu,
  [string]$Cuda = 'cu128',
  [string]$Venv = 'env\venv',
  [switch]$Minimal,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ------------------------------------------------------------------ 常量

# 最小依赖集：按 `vendor/OmniShotCut-main/omnishotcut/**` 的实际 import 审计
# （cv2 / ffmpeg / numpy / PIL / packaging / huggingface_hub / torch / torchvision）。
# 模型推理不需要 pandas / sklearn / matplotlib / tensorboard / transformers / gradio。
$CoreDeps = @(
  'numpy',
  'opencv-python-headless',   # 桥只做推理，不需要 GUI 版 opencv
  'ffmpeg-python',
  'pillow',
  'packaging',
  'huggingface_hub'
)
# 默认多装的轻量周边：上游 requirements.txt 里有、且不拖 torch 训练栈的那几个。
# 明确**不装**：gradio / spaces（app.py 的网页 UI）、accelerate / transformers /
# scikit-learn / matplotlib / tensorboard（训练与评测栈）—— 这个后端用不到。
$ExtraDeps = @('tqdm', 'omegaconf', 'imageio', 'pandas')

$PipTorchArgs = @()   # torch/torchvision 共用的参数（--force-reinstall 等）

# ------------------------------------------------------------------ 小工具

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "== $Text" -ForegroundColor Cyan
}

function Write-Info([string]$Text) { Write-Host "   $Text" }
function Write-Warn2([string]$Text) { Write-Host " ! $Text" -ForegroundColor Yellow }

function Invoke-Pip {
  param([string]$Python, [string[]]$Arguments)
  Write-Host "   > $Python -m pip $($Arguments -join ' ')" -ForegroundColor DarkGray
  & $Python -m pip @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pip 失败（退出码 $LASTEXITCODE）：pip $($Arguments -join ' ')"
  }
}

function Get-NvidiaGpu {
  <# 有卡 → 返回显卡名；没卡 / 没驱动 / 没 nvidia-smi → $null #>
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { return $null }
  try {
    # 不要在这条管道上接 Select-Object -First 1：提前掐断原生进程会让 $LASTEXITCODE 变非 0，
    # 于是"有卡"被判成"没卡"（实测踩过一次）。先全收下来再取第一条。
    $out = & $smi.Source --query-gpu=name --format=csv,noheader 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) {
      $first = @($out)[0]
      if ($first) { return "$first".Trim() }
    }
  } catch { }
  return $null
}

function Get-TorchState {
  <# 读目标 venv 里现成的 torch：@(版本, cuda版本, 有无) —— 没装时 has=$false #>
  param([string]$Python)
  if (-not (Test-Path $Python)) { return [pscustomobject]@{ Has = $false; Version = ''; Cuda = ''; Flavor = '' } }
  $raw = & $Python -c "import torch;print(torch.__version__);print(torch.version.cuda or '')" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    return [pscustomobject]@{ Has = $false; Version = ''; Cuda = ''; Flavor = '' }
  }
  $lines = @($raw | ForEach-Object { "$_".Trim() } | Where-Object { $_ -ne '' })
  $ver = if ($lines.Count -ge 1) { $lines[0] } else { '' }
  $cu = if ($lines.Count -ge 2) { $lines[1] } else { '' }
  $flavor = ''
  if ($ver -match '\+(.+)$') { $flavor = $Matches[1] }
  elseif ($cu) { $flavor = 'cu' + ($cu -replace '\.', '') }
  elseif ($ver) { $flavor = 'cpu' }
  return [pscustomobject]@{ Has = [bool]$ver; Version = $ver; Cuda = $cu; Flavor = $flavor }
}

function Get-DirSizeMb([string]$Path) {
  if (-not (Test-Path $Path)) { return 0 }
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if (-not $sum) { return 0 }
  return [math]::Round($sum / 1MB, 1)
}

# ------------------------------------------------------------------ 0. 定位

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$VendorPath = Join-Path $RepoRoot 'vendor\OmniShotCut-main'
$BridgePath = Join-Path $RepoRoot 'plugin\src\storyboard\omnishotcut-bridge.py'

if (-not (Test-Path (Join-Path $VendorPath 'pyproject.toml'))) {
  throw "找不到 vendor\OmniShotCut-main（仓库根解析成 $RepoRoot）。脚本必须放在 plugin\scripts\ 下。"
}

$VenvPath = if ([System.IO.Path]::IsPathRooted($Venv)) { $Venv } else { Join-Path $RepoRoot $Venv }
$PythonPath = Join-Path $VenvPath 'Scripts\python.exe'

# ------------------------------------------------------------------ 1. 选 flavor

$cudaBound = $PSBoundParameters.ContainsKey('Cuda')
if ($Cpu -and $cudaBound) { throw '-Cpu 与 -Cuda 互斥：一个要 CPU 版，一个要 CUDA 版。' }

# 显卡探测总是跑（只读）：即使 -Cpu / -Cuda 指定了，报告里也要如实说这台机器有没有卡
$gpu = Get-NvidiaGpu

# 2026-11-16 决策：**CPU 是默认、也是唯一保证支持的形态**。
# 有卡机器也默认装 CPU —— 端到端只慢 1.4–6 倍（短片 12 s / 120 s 片 35 s），
# 换来 557 MB 而不是 4,984 MB 的安装体积，且没有驱动/flavor 配对问题。
# 想快就显式 -Cuda cu128（标为实验性，不做多版本矩阵、不阻塞发布）。
if ($Cpu) { $flavor = 'cpu' }
elseif ($cudaBound) { $flavor = $Cuda }
else { $flavor = 'cpu' }

$IndexUrl = "https://download.pytorch.org/whl/$flavor"
$targetIsCpu = ($flavor -eq 'cpu')

Write-Host ''
Write-Host 'OmniShotCut 安装器' -ForegroundColor Green
Write-Info "仓库根   : $RepoRoot"
Write-Info "目标 venv: $VenvPath"
Write-Info "torch    : $flavor  ($IndexUrl)"
Write-Info "显卡     : $(if ($gpu) { $gpu } else { 'nvidia-smi 没报出显卡（按无卡处理）' })"
Write-Info "依赖集   : $(if ($Minimal) { '最小集' } else { '最小集 + 轻量周边' })"

if ($cudaBound -and -not $gpu) {
  Write-Warn2 "显式指定了 -Cuda $Cuda，但这台机器 nvidia-smi 没报出显卡。"
  Write-Warn2 '装完 torch.cuda.is_available() 大概率是 False；那时把 DSH_OSM_DEVICE 设成 auto 或 cpu。'
}

# ------------------------------------------------------------------ 2. venv

Write-Step '1/6 准备 venv'
$createdVenv = $false
if (Test-Path $PythonPath) {
  Write-Info "已存在：$PythonPath"
} else {
  Write-Info "创建：$VenvPath"
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    # 优先 3.14：本机 env\downloads 里的 cu128 wheel 是 cp314，同版本能离线恢复
    & $pyLauncher.Source -3.14 -m venv $VenvPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $PythonPath)) {
      & $pyLauncher.Source -3 -m venv $VenvPath
    }
  } else {
    & python -m venv $VenvPath
  }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $PythonPath)) {
    throw "建 venv 失败：$VenvPath（先确认 py -3.14 或 python 可用）"
  }
  $createdVenv = $true
}
# 只在**刚建的** venv 上升 pip：已有的 venv 是用户的资产（里面可能是 2.6 GB 的 CUDA torch），
# 安全检查还没过之前不许动它一个字节。
if ($createdVenv) {
  & $PythonPath -m pip install --upgrade pip 2>&1 | Select-Object -Last 1 | Out-Null
}

# ------------------------------------------------------------------ 3. 安全条款

Write-Step '2/6 安全检查：会不会把 CUDA 版 torch 换成 CPU 版'
$state = Get-TorchState -Python $PythonPath
if ($state.Has) {
  Write-Info "现有 torch: $($state.Version)  (cuda=$($state.Cuda))"
} else {
  Write-Info '现有 torch: 没装（干净 venv）'
}

$existingIsCuda = $state.Has -and (($state.Version -match '\+cu\d+') -or ($state.Cuda -ne ''))

if ($existingIsCuda -and $targetIsCpu -and -not $Force) {
  Write-Host ''
  Write-Host '  !!! 拒绝执行：目标 venv 里现在是 CUDA 版 torch，这次要装的是 CPU 版。' -ForegroundColor Red
  Write-Host '      CPU 版会覆盖 CUDA 版，装完 torch.cuda.is_available() 变成 False，' -ForegroundColor Red
  Write-Host '      120 s 的片子从 ~5.6 s 变成 ~24 s（历史事故：docs/incidents/torch-被-CPU-版覆盖.md）。' -ForegroundColor Red
  Write-Host ''
  Write-Host '  想清楚后的三条路：' -ForegroundColor Yellow
  Write-Host '    ① 真要降级 → 加 -Force 重跑（会从 pytorch 索引重下 CPU wheel）'
  Write-Host '    ② 只想验 CPU 路径 → 换一个 venv：-Venv env\venv-cpu'
  Write-Host '    ③ 装错了想恢复 → 见下面命令（离线，用 env\downloads 里的 wheel）'
  Write-Host ''
  Write-Host "      `$py = '$PythonPath'" -ForegroundColor DarkGray
  Write-Host '      & $py -m pip install --no-index --no-deps --force-reinstall `' -ForegroundColor DarkGray
  Write-Host '            "env\downloads\torch-2.11.0+cu128-cp314-cp314-win_amd64.whl"' -ForegroundColor DarkGray
  Write-Host '      & $py -m pip install --no-index --no-deps --force-reinstall `' -ForegroundColor DarkGray
  Write-Host '            "env\downloads\torchvision-0.26.0+cu128-cp314-cp314-win_amd64.whl"' -ForegroundColor DarkGray
  Write-Host '      & $py -c "import torch;print(torch.__version__, torch.cuda.is_available())"' -ForegroundColor DarkGray
  exit 2
}

if (-not $existingIsCuda -and $state.Has -and -not $targetIsCpu) {
  Write-Warn2 "现有是 $($state.Flavor) 版，这次要装 $flavor —— 会重装 torch/torchvision（~2.6 GB 下载）。"
}

if ($state.Flavor -and $state.Flavor -ne $flavor) {
  # 同名同版本号、只有本地标记不同时，pip 认为"已满足"，必须显式 force
  $PipTorchArgs += '--force-reinstall'
  Write-Info "flavor 从 $($state.Flavor) 换成 $flavor → 加 --force-reinstall"
}

# ------------------------------------------------------------------ 4. torch / torchvision

Write-Step "3/6 装 torch + torchvision（$flavor）"
$torchArgs = @('install', '--index-url', $IndexUrl) + $PipTorchArgs + @('torch', 'torchvision')
Invoke-Pip -Python $PythonPath -Arguments $torchArgs

# ------------------------------------------------------------------ 5. 依赖

Write-Step "4/6 装依赖（$(if ($Minimal) { '最小集' } else { '最小集 + 轻量周边' })）"
$deps = @($CoreDeps)
if (-not $Minimal) { $deps += $ExtraDeps }

# opencv-python 与 opencv-python-headless 装在一起会互相覆盖 cv2/，已有 GUI 版就别再装 headless
$hasGuiOpencv = $false
& $PythonPath -m pip show opencv-python *> $null
if ($LASTEXITCODE -eq 0) { $hasGuiOpencv = $true }
if ($hasGuiOpencv -and ($deps -contains 'opencv-python-headless')) {
  $deps = $deps | Where-Object { $_ -ne 'opencv-python-headless' }
  Write-Info '已有 opencv-python，跳过 opencv-python-headless（两个包会抢同一个 cv2 目录）'
}
Invoke-Pip -Python $PythonPath -Arguments (@('install') + $deps)

# ------------------------------------------------------------------ 6. omnishotcut（--no-deps！）

Write-Step '5/6 装 omnishotcut（editable，--no-deps）'
Write-Info '--no-deps 是硬性的：它声明 torch>=2.0，带依赖装会从 PyPI 抓 CPU wheel 覆盖掉刚装的 torch。'
Invoke-Pip -Python $PythonPath -Arguments @('install', '--no-deps', '-e', $VendorPath)

# ------------------------------------------------------------------ 7. 报告

Write-Step '6/6 结果'

$verLine = & $PythonPath -c "import torch;print(torch.__version__, torch.cuda.is_available())" 2>&1
$tvLine = & $PythonPath -c "import torchvision;print(torchvision.__version__)" 2>&1
# 包本身没有 __version__，版本号从 distribution 元数据拿；同时 import 一次证明 editable 真的挂上了
$osmLine = & $PythonPath -c "import importlib.metadata as m,omnishotcut;print(m.version('omnishotcut'))" 2>&1
$sizeMb = Get-DirSizeMb $VenvPath

Write-Host ''
Write-Host '装好了。' -ForegroundColor Green
Write-Info "venv        : $VenvPath"
Write-Info "wheel       : torch $($verLine -join ' ') / torchvision $($tvLine -join ' ')"
Write-Info "索引        : $IndexUrl"
Write-Info "venv 体积   : $sizeMb MB"
Write-Info "omnishotcut : $($osmLine -join ' ')（editable → $VendorPath）"
Write-Info "验证        : $($verLine -join ' ')"

# 设备解析顺手跑一次桥的探针：把"这个 venv + 这台机器"解析成什么设备，一次说清
if (Test-Path $BridgePath) {
  $probe = & $PythonPath $BridgePath --probe-device 2>&1
  $probeExit = $LASTEXITCODE
  Write-Info "设备探针    : $($probe -join ' ')  (exit=$probeExit)"
  if ($probeExit -ne 0) {
    Write-Warn2 "设备探针失败 —— 若 DSH_OSM_DEVICE=cuda 而这里是 cpu 版 torch，运行时会直接报 device-unavailable。"
  }
} else {
  Write-Warn2 "桥不在：$BridgePath（插件包可能没装全）"
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host "  `$env:DSH_OSM_PYTHON = '$PythonPath'"
Write-Host "  `$env:DSH_OSM_CKPT   = '<仓库根>\models\omnishotcut_ckpt.pth'"
Write-Host '  node bin\doctor.mjs        # 看 device 那一行'
Write-Host '  DSH_OSM_DEVICE=auto|cpu|cuda（默认 auto）；DSH_OSM_THREADS 覆盖 CPU 线程数（默认 4）'
Write-Host '  详细说明：plugin\安装-OmniShotCut.md'
exit 0
