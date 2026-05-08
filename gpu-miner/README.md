# rpow-miner-gpu

CUDA SHA-256 trailing-zero-bits PoW miner for NVIDIA GPUs. Exposes the same
CLI and stdout JSON protocol as the Rust reference miner, so the Node
orchestrator can pick it up via `--backend=gpu`.

## Build on Windows

### 1. Install the CUDA Toolkit (one-time)

Download CUDA 12.x Windows installer from:

- https://developer.nvidia.com/cuda-downloads
  → Windows → x86_64 → 11/10 → `exe (local)` (≈ 3 GB)

Run the installer. Default options are fine. This installs `nvcc.exe` at
something like:

    C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin\nvcc.exe

The installer requires **Visual Studio 2022 (or 2019) with the "Desktop
development with C++" workload**. If you don't have it, install Visual Studio
Community first (free): https://visualstudio.microsoft.com/downloads/ — you
only need the MSVC build tools, not the full IDE.

### 2. Build the miner

In a fresh PowerShell:

```powershell
cd gpu-miner
.\build.ps1
```

The script auto-detects your GPU architecture (`sm_86` for RTX 2050) and
produces `rpow-miner-gpu.exe` in the same folder.

If it can't find `nvcc`, either restart the shell (PATH updated by the
installer) or run from the "x64 Native Tools Command Prompt for VS 2022".

### 3. Smoke test

```powershell
.\rpow-miner-gpu.exe --prefix 3c5d81491a6d4fdee6d5787ffa8d64fc --difficulty 20
```

Should print progress lines, then a `{"type":"found",...}` JSON line and
exit 0 within a second or two.

## How to use from the mining loop

In the main `rpow` repo, pass `--backend=gpu`:

```powershell
node rpow.js mine --profile=gilang --backend=gpu --inflight=2
```

The orchestrator finds `gpu-miner/rpow-miner-gpu.exe`, spawns it per
challenge, and mints as solutions come in. `--workers` is ignored by the
GPU backend (the kernel uses the whole device).

## Tuning

Default launch config is tuned for RTX 20/30-series. For other GPUs you can
override:

```powershell
.\rpow-miner-gpu.exe --prefix ... --difficulty 30 --grid 8192 --block 256 --batch 128
```

- `--grid N`  : number of CUDA blocks per launch (default 4096)
- `--block N` : threads per block (default 256, keep multiple of 32)
- `--batch N` : nonces each thread tries per launch (default 64)

Higher `grid * block * batch` = fewer kernel launches, more hashes per
launch. Too large and the GPU preempts for display refresh; on a laptop
with an integrated display on the same GPU, reduce `batch` if the screen
lags.
