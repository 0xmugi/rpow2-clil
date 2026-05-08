// rpow-miner-gpu: CUDA SHA-256 trailing-zero-bits PoW miner.
//
// Same CLI + stdout JSON protocol as the Rust reference miner, so the
// existing Node orchestrator can drop it in via --backend=gpu.
//
// CLI:
//   rpow-miner-gpu --prefix <hex> --difficulty <bits>
//                  [--start-nonce <u64>] [--device <idx>]
//                  [--batch <u32>] [--grid <u32>] [--block <u32>]
//                  [--workers <N>]    (ignored, for arg compat)
//
// Protocol (one JSON object per line on stdout):
//   {"type":"progress","hashes":<u64>,"elapsed_ms":<u64>}
//   {"type":"found","nonce":"<u64>","digest":"<hex>",
//    "trailing_zero_bits":<u32>,"hashes":<u64>,"elapsed_ms":<u64>}
//   {"type":"error","message":"..."}
//
// Exit codes: 0 = solution, 1 = error, 130 = aborted (SIGINT).
//
// Build (Windows):
//   nvcc -O3 -arch=sm_86 -o rpow-miner-gpu.exe main.cu
//   (arch=sm_86 for Ampere; adjust for other GPUs)

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cstdarg>
#include <chrono>
#include <thread>
#include <atomic>
#include <csignal>
#include <string>
#include <vector>
#include <cuda_runtime.h>

// ---- host globals & CLI -----------------------------------------------

static std::atomic<bool> g_abort(false);
static void on_signal(int) { g_abort.store(true); }

static void emit_json(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
}

static void die(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    // Escape double-quotes in message.
    std::string s;
    for (const char* p = buf; *p; ++p) {
        if (*p == '"') s += "\\\"";
        else if (*p == '\\') s += "\\\\";
        else s += *p;
    }
    emit_json("{\"type\":\"error\",\"message\":\"%s\"}", s.c_str());
    std::exit(1);
}

#define CUDA_CHECK(call) do { \
    cudaError_t _e = (call); \
    if (_e != cudaSuccess) die("cuda error: %s (at %s:%d)", cudaGetErrorString(_e), __FILE__, __LINE__); \
} while (0)

static std::vector<uint8_t> hex_decode(const std::string& hex) {
    if (hex.size() % 2 != 0) die("prefix must have even hex length");
    std::vector<uint8_t> out;
    out.reserve(hex.size() / 2);
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < hex.size(); i += 2) {
        int hi = nib(hex[i]);
        int lo = nib(hex[i + 1]);
        if (hi < 0 || lo < 0) die("prefix is not valid hex");
        out.push_back((uint8_t)((hi << 4) | lo));
    }
    return out;
}

// ---- SHA-256 constants (used on device via __constant__) --------------

__constant__ uint32_t c_K[64];
__constant__ uint8_t  c_msg_template[64];  // prefix + padding (nonce bytes are
                                           // overwritten per-thread)
__constant__ uint32_t c_prefix_len;
__constant__ uint32_t c_difficulty;

// ---- device SHA-256 (single 64-byte block) ---------------------------

__device__ __forceinline__ uint32_t rotr32(uint32_t x, int n) {
    return (x >> n) | (x << (32 - n));
}

// Compresses one 64-byte block held in the 16 low W[] words. H is the
// initial state; on return H contains the final hash state.
__device__ __forceinline__ void sha256_block(uint32_t W[64], uint32_t H[8]) {
    #pragma unroll
    for (int i = 16; i < 64; ++i) {
        uint32_t s0 = rotr32(W[i - 15], 7) ^ rotr32(W[i - 15], 18) ^ (W[i - 15] >> 3);
        uint32_t s1 = rotr32(W[i - 2], 17) ^ rotr32(W[i - 2], 19) ^ (W[i - 2] >> 10);
        W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    uint32_t a = H[0], b = H[1], c = H[2], d = H[3];
    uint32_t e = H[4], f = H[5], g = H[6], h = H[7];
    #pragma unroll
    for (int i = 0; i < 64; ++i) {
        uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + c_K[i] + W[i];
        uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;
        h = g; g = f; f = e;
        e = d + t1;
        d = c; c = b; b = a;
        a = t1 + t2;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d;
    H[4] += e; H[5] += f; H[6] += g; H[7] += h;
}

// ---- mining kernel ----------------------------------------------------

// Each thread tries `batch` consecutive nonces starting at
//   start_nonce + (thread_idx * batch).
// When any thread finds a digest with >= c_difficulty trailing-zero bits,
// it atomically claims *found_flag and writes nonce + digest.
__global__ void mine_kernel(
    uint64_t start_nonce,
    uint32_t batch,
    int* __restrict__ found_flag,
    uint64_t* __restrict__ found_nonce,
    uint32_t* __restrict__ found_digest  // 8 x u32, big-endian words
) {
    const uint64_t thread_idx =
        (uint64_t)blockIdx.x * (uint64_t)blockDim.x + (uint64_t)threadIdx.x;

    if (*found_flag) return;

    // Build this thread's message: template (prefix + padding) with
    // nonce bytes patched in. Held in registers/local memory.
    uint8_t msg[64];
    #pragma unroll
    for (int i = 0; i < 64; ++i) msg[i] = c_msg_template[i];

    const uint32_t prefix_len = c_prefix_len;
    const uint32_t difficulty = c_difficulty;

    const uint64_t base_nonce = start_nonce + thread_idx * (uint64_t)batch;

    for (uint32_t i = 0; i < batch; ++i) {
        // Cooperative early-exit every 1024 tries (cheap shared-mem style read).
        if ((i & 1023u) == 0u && *found_flag) return;

        const uint64_t nonce = base_nonce + i;

        // Patch nonce bytes (little-endian) at offset prefix_len.
        #pragma unroll
        for (int j = 0; j < 8; ++j) {
            msg[prefix_len + j] = (uint8_t)(nonce >> (j * 8));
        }

        // Pack the 64-byte message into 16 big-endian 32-bit words.
        uint32_t W[64];
        #pragma unroll
        for (int j = 0; j < 16; ++j) {
            W[j] =  ((uint32_t)msg[j * 4 + 0] << 24)
                  | ((uint32_t)msg[j * 4 + 1] << 16)
                  | ((uint32_t)msg[j * 4 + 2] <<  8)
                  |  (uint32_t)msg[j * 4 + 3];
        }

        // SHA-256 initial state.
        uint32_t H[8] = {
            0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
            0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
        };
        sha256_block(W, H);

        // Digest byte ordering: byte 28..31 = H[7] big-endian.
        //   byte 31 = H[7] & 0xFF       (low byte)
        //   byte 30 = (H[7] >> 8) & 0xFF
        //   byte 29 = (H[7] >> 16) & 0xFF
        //   byte 28 = (H[7] >> 24) & 0xFF (high byte)
        // trailing_zero_bits counts from byte 31 downward. So the low
        // `difficulty` bits of H[7] (interpreted as a little-endian byte
        // stream) must be zero, then H[6], etc.
        //
        // For difficulty <= 32: (H[7] & ((1<<diff)-1)) == 0.
        // For difficulty <= 64: H[7] == 0 && (H[6] & ((1<<(diff-32))-1)) == 0.
        bool ok;
        if (difficulty <= 32) {
            uint64_t mask = (difficulty == 32)
                ? 0xFFFFFFFFull
                : ((1ull << difficulty) - 1ull);
            ok = (((uint64_t)H[7]) & mask) == 0ull;
        } else if (difficulty <= 64) {
            uint32_t d2 = difficulty - 32;
            uint64_t mask = (d2 == 32)
                ? 0xFFFFFFFFull
                : ((1ull << d2) - 1ull);
            ok = (H[7] == 0) && ((((uint64_t)H[6]) & mask) == 0ull);
        } else {
            // Difficulty above 64 bits is astronomically unlikely near-term.
            ok = false;
        }

        if (ok) {
            if (atomicCAS(found_flag, 0, 1) == 0) {
                *found_nonce = nonce;
                #pragma unroll
                for (int j = 0; j < 8; ++j) found_digest[j] = H[j];
            }
            return;
        }
    }
}

// ---- main -------------------------------------------------------------

int main(int argc, char** argv) {
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    std::string prefix_hex;
    uint32_t difficulty = 0;
    uint64_t start_nonce = 0;
    int device = 0;
    uint32_t batch = 64;     // nonces per thread per launch
    uint32_t grid = 4096;    // blocks per launch
    uint32_t block = 256;    // threads per block

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](const char* name) -> std::string {
            if (i + 1 >= argc) die("missing value for %s", name);
            return argv[++i];
        };
        if (a == "--prefix")            prefix_hex = next("--prefix");
        else if (a == "--difficulty")   difficulty = (uint32_t)std::stoul(next("--difficulty"));
        else if (a == "--start-nonce")  start_nonce = std::stoull(next("--start-nonce"));
        else if (a == "--device")       device = std::stoi(next("--device"));
        else if (a == "--batch")        batch = (uint32_t)std::stoul(next("--batch"));
        else if (a == "--grid")         grid = (uint32_t)std::stoul(next("--grid"));
        else if (a == "--block")        block = (uint32_t)std::stoul(next("--block"));
        else if (a == "--workers")      (void)next("--workers"); // ignored; for CLI compat
        else if (a == "--help" || a == "-h") {
            fprintf(stderr,
                "usage: rpow-miner-gpu --prefix <hex> --difficulty <bits>\n"
                "  [--start-nonce u64] [--device idx] [--batch N] [--grid N] [--block N]\n");
            return 0;
        } else {
            die("unknown arg: %s", a.c_str());
        }
    }
    if (prefix_hex.empty()) die("--prefix is required");
    if (difficulty == 0 || difficulty > 256) die("difficulty must be 1..=256");

    std::vector<uint8_t> prefix = hex_decode(prefix_hex);
    if (prefix.size() + 8 + 1 + 8 > 64) {
        die("prefix too long: %zu bytes (max 47 for single-block SHA-256)",
            prefix.size());
    }

    CUDA_CHECK(cudaSetDevice(device));

    // Build 64-byte message template: [prefix][8 nonce placeholder][0x80][zeros][bitlen BE].
    uint8_t msg_template[64] = {0};
    std::memcpy(msg_template, prefix.data(), prefix.size());
    const uint32_t data_len = (uint32_t)prefix.size() + 8; // prefix + nonce
    msg_template[data_len] = 0x80;
    // zeros already via {0}
    uint64_t bitlen = (uint64_t)data_len * 8ull;
    for (int i = 0; i < 8; ++i) {
        msg_template[56 + i] = (uint8_t)(bitlen >> ((7 - i) * 8));
    }

    // SHA-256 round constants.
    const uint32_t K[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    };

    uint32_t prefix_len_u = (uint32_t)prefix.size();

    // Copy config to device constant memory.
    CUDA_CHECK(cudaMemcpyToSymbol(c_K,            K,            sizeof(K)));
    CUDA_CHECK(cudaMemcpyToSymbol(c_msg_template, msg_template, sizeof(msg_template)));
    CUDA_CHECK(cudaMemcpyToSymbol(c_prefix_len,   &prefix_len_u, sizeof(uint32_t)));
    CUDA_CHECK(cudaMemcpyToSymbol(c_difficulty,   &difficulty,   sizeof(uint32_t)));

    // Allocate result slots on device.
    int*      d_found_flag   = nullptr;
    uint64_t* d_found_nonce  = nullptr;
    uint32_t* d_found_digest = nullptr;
    CUDA_CHECK(cudaMalloc(&d_found_flag,   sizeof(int)));
    CUDA_CHECK(cudaMalloc(&d_found_nonce,  sizeof(uint64_t)));
    CUDA_CHECK(cudaMalloc(&d_found_digest, 8 * sizeof(uint32_t)));
    CUDA_CHECK(cudaMemset(d_found_flag, 0, sizeof(int)));

    auto t0 = std::chrono::steady_clock::now();
    uint64_t total_hashes = 0;
    uint64_t nonce = start_nonce;

    // Report progress from a separate thread so tight kernel launches
    // don't block progress output.
    std::atomic<uint64_t> reported_hashes(0);
    std::atomic<bool> stop_reporter(false);
    std::thread reporter([&]() {
        while (!stop_reporter.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            if (stop_reporter.load()) break;
            auto ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - t0).count();
            emit_json("{\"type\":\"progress\",\"hashes\":%llu,\"elapsed_ms\":%llu}",
                      (unsigned long long)reported_hashes.load(),
                      (unsigned long long)ms);
        }
    });

    bool found = false;
    uint64_t found_nonce_host = 0;
    uint32_t found_digest_host[8] = {0};

    dim3 grid_dim(grid);
    dim3 block_dim(block);
    const uint64_t nonces_per_launch = (uint64_t)grid * (uint64_t)block * (uint64_t)batch;

    int host_flag = 0;
    while (!found) {
        if (g_abort.load()) {
            stop_reporter.store(true);
            reporter.join();
            auto ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::steady_clock::now() - t0).count();
            emit_json("{\"type\":\"aborted\",\"hashes\":%llu,\"elapsed_ms\":%llu}",
                      (unsigned long long)total_hashes,
                      (unsigned long long)ms);
            cudaFree(d_found_flag);
            cudaFree(d_found_nonce);
            cudaFree(d_found_digest);
            return 130;
        }

        mine_kernel<<<grid_dim, block_dim>>>(
            nonce, batch, d_found_flag, d_found_nonce, d_found_digest);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());

        total_hashes += nonces_per_launch;
        reported_hashes.store(total_hashes);
        nonce += nonces_per_launch;

        CUDA_CHECK(cudaMemcpy(&host_flag, d_found_flag, sizeof(int), cudaMemcpyDeviceToHost));
        if (host_flag) {
            CUDA_CHECK(cudaMemcpy(&found_nonce_host, d_found_nonce,
                                  sizeof(uint64_t), cudaMemcpyDeviceToHost));
            CUDA_CHECK(cudaMemcpy(found_digest_host, d_found_digest,
                                  8 * sizeof(uint32_t), cudaMemcpyDeviceToHost));
            found = true;
        }
    }

    stop_reporter.store(true);
    reporter.join();

    // Convert digest words (big-endian) to hex bytes.
    char hex_buf[65];
    for (int i = 0; i < 8; ++i) {
        uint32_t w = found_digest_host[i];
        snprintf(hex_buf + i * 8, 9, "%08x", w);
    }
    hex_buf[64] = 0;

    // Count trailing zero bits of the 32-byte digest (bytes 31..0).
    uint8_t dbytes[32];
    for (int i = 0; i < 8; ++i) {
        uint32_t w = found_digest_host[i];
        dbytes[i * 4 + 0] = (uint8_t)(w >> 24);
        dbytes[i * 4 + 1] = (uint8_t)(w >> 16);
        dbytes[i * 4 + 2] = (uint8_t)(w >>  8);
        dbytes[i * 4 + 3] = (uint8_t)(w      );
    }
    uint32_t tz = 0;
    for (int i = 31; i >= 0; --i) {
        uint8_t b = dbytes[i];
        if (b == 0) { tz += 8; continue; }
        // count low-order zero bits of b
        uint32_t extra = 0;
        while (((b >> extra) & 1u) == 0u && extra < 8u) ++extra;
        tz += extra;
        break;
    }

    auto ms = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - t0).count();
    emit_json(
        "{\"type\":\"found\",\"nonce\":\"%llu\",\"digest\":\"%s\","
        "\"trailing_zero_bits\":%u,\"hashes\":%llu,\"elapsed_ms\":%llu}",
        (unsigned long long)found_nonce_host,
        hex_buf,
        tz,
        (unsigned long long)total_hashes,
        (unsigned long long)ms);

    cudaFree(d_found_flag);
    cudaFree(d_found_nonce);
    cudaFree(d_found_digest);
    return 0;
}
