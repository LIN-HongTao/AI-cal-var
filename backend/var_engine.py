import math
from typing import List, Dict, Any

import numpy as np


# ==================== 基础统计（对齐 JS 口径） ====================

def mean(arr: np.ndarray) -> float:
    return float(np.mean(arr))


def std_sample(arr: np.ndarray) -> float:
    # JS 版 std 使用 n-1
    return float(np.std(arr, ddof=1))


def _np_quantile_linear(arr: np.ndarray, q: float) -> float:
    """兼容不同 NumPy 版本的线性分位数（行为与常见 JS 插值一致）。"""
    a = np.asarray(arr, dtype=float)
    if a.size == 0:
        return float("nan")
    # NumPy >= 1.22: method；旧版：interpolation
    try:
        return float(np.quantile(a, q, method="linear"))  # type: ignore[arg-type]
    except TypeError:
        return float(np.quantile(a, q, interpolation="linear"))  # type: ignore[arg-type]


def z_from_conf(conf: float) -> float:
    if abs(conf - 0.95) < 1e-6:
        return 1.645
    if abs(conf - 0.99) < 1e-6:
        return 2.33

    # Moro approximation（与 varWorker.js 一致）
    a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637]
    b = [-8.47351093090, 23.08336743743, -21.06224101826, 3.13082909833]
    c = [
        0.3374754822726147,
        0.9761690190917186,
        0.1607979714918209,
        0.0276438810333863,
        0.0038405729373609,
        0.0003951896511919,
        0.0000321767881768,
        0.0000002888167364,
        0.0000003960315187,
    ]

    y = conf - 0.5
    if abs(y) < 0.42:
        r = y * y
        num = y * (((a[3] * r + a[2]) * r + a[1]) * r + a[0])
        den = ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1.0)
        return num / den

    r = conf if y <= 0 else 1.0 - conf
    r = math.log(-math.log(r))
    x = c[0]
    for i in range(1, len(c)):
        x += c[i] * (r ** i)
    return x if y > 0 else -x


# ==================== t 分布拟合（对齐 worker：标准化后做 ν 网格） ====================

def student_t_loglike(x: np.ndarray, df: float) -> float:
    # JS 中用近似 lgamma；Python 直接用 math.lgamma（更精确）
    a = math.lgamma((df + 1.0) / 2.0) - math.lgamma(df / 2.0) - 0.5 * math.log(df * math.pi)
    return float(np.sum(a - (df + 1.0) / 2.0 * np.log1p((x * x) / df)))


def fit_t_df_mle(r: np.ndarray, df_min: int = 3, df_max: int = 60) -> int:
    mu = mean(r)
    sigma = std_sample(r)
    if sigma <= 0 or not np.isfinite(sigma):
        return 5
    x = (r - mu) / sigma

    best_df = df_min
    best_ll = -1e100
    # 整数网格搜索（与原 JS/worker 逻辑一致，稳定且足够快）
    for df in range(df_min, df_max + 1):
        ll = student_t_loglike(x, float(df))
        if ll > best_ll:
            best_ll = ll
            best_df = df
    return int(best_df)


# ==================== Monte Carlo（对齐 worker：mcSingle） ====================

# 保护性上限：避免误操作把后端打爆
_MAX_SIMS = 2_000_000
_MAX_T = 2_500
_MAX_SIM_ELEMS = 60_000_000  # sims*T 过大时直接拒绝（内存/CPU）


def _validate_inputs(conf: float, T: int, sims: int, method: str, df_max: int) -> None:
    if not (0.0 < conf < 1.0):
        raise ValueError("conf must be in (0, 1)")
    if T < 1:
        raise ValueError("T must be >= 1")
    if sims < 1:
        raise ValueError("sims must be >= 1")
    if sims > _MAX_SIMS:
        raise ValueError(f"sims too large (max={_MAX_SIMS})")
    if T > _MAX_T:
        raise ValueError(f"T too large (max={_MAX_T})")
    if sims * T > _MAX_SIM_ELEMS:
        raise ValueError(f"sims*T too large (max={_MAX_SIM_ELEMS})")
    if method not in {"normal", "t_mc", "bootstrap"}:
        raise ValueError(f"Unknown method: {method}")
    if df_max < 3:
        raise ValueError("dfMax must be >= 3")


def _choose_chunk_size(sims: int, T: int) -> int:
    # 目标：每块 draws 大小约 5e6（float64 ~ 40MB），兼顾速度与内存峰值
    target_elems = 5_000_000
    chunk = max(10_000, min(sims, target_elems // max(1, T)))
    return int(chunk)


def mc_single(r: List[float], conf: float, T: int, sims: int, method: str, df_max: int) -> Dict[str, Any]:
    """
    对齐 varWorker.js: task === 'mcSingle'
    - normal: μ=0（前端已中心化；这里强制口径一致），sigma * N(0,1)
    - t_mc  : μ=0，scale * t(dfHat)，scale = sigma*sqrt((df-2)/df)
    - bootstrap: 从 r 中重采样拼路径
    返回结构尽量与 worker 一致：{ok:true, var, mu?, sigma?, nu?, z?}
    """
    _validate_inputs(float(conf), int(T), int(sims), str(method), int(df_max))

    rr = np.asarray(r, dtype=float)
    rr = rr[np.isfinite(rr)]
    if rr.size < 2:
        return {"ok": True, "var": float("nan")}

    # conf：取损失分布的 conf 分位数（等价于收益左尾 1-conf 分位数取负）
    q_loss = float(conf)

    # 口径：后端强制 μ=0，避免未来入口变化造成口径漂移
    mu = 0.0

    sigma = std_sample(rr)
    if not np.isfinite(sigma) or sigma < 0:
        sigma = float("nan")

    rng = np.random.default_rng()
    Rs = np.empty(int(sims), dtype=float)

    chunk = _choose_chunk_size(int(sims), int(T))
    pos = 0

    if method == "normal":
        # sigma 退化时，收益恒为 0（μ=0 口径）
        if not np.isfinite(sigma) or sigma <= 0:
            Rs.fill(0.0)
        else:
            while pos < sims:
                m = min(chunk, sims - pos)
                draws = rng.standard_normal(size=(m, int(T)))
                Rs[pos:pos + m] = sigma * np.sum(draws, axis=1) + mu * T
                pos += m

        losses = -Rs
        v = _np_quantile_linear(losses, q_loss)
        v = max(0.0, float(v))
        return {"ok": True, "var": v, "mu": mu, "sigma": float(sigma)}

    if method == "t_mc":
        # sigma 退化时同样返回 0
        if not np.isfinite(sigma) or sigma <= 0:
            Rs.fill(0.0)
            df_hat = 5
        else:
            df_hat = fit_t_df_mle(rr, 3, int(df_max))
            # 对齐 worker：让 t 的方差匹配 sigma^2（df>2）
            scale = sigma * math.sqrt((df_hat - 2) / df_hat) if df_hat > 2 else sigma

            while pos < sims:
                m = min(chunk, sims - pos)
                draws = rng.standard_t(df_hat, size=(m, int(T)))
                Rs[pos:pos + m] = scale * np.sum(draws, axis=1) + mu * T
                pos += m

        losses = -Rs
        v = _np_quantile_linear(losses, q_loss)
        v = max(0.0, float(v))
        return {
            "ok": True,
            "var": v,
            "mu": mu,
            "sigma": float(sigma),
            "nu": int(df_hat),
            "z": z_from_conf(float(conf)),
        }

    # bootstrap
    while pos < sims:
        m = min(chunk, sims - pos)
        idx = rng.integers(0, rr.size, size=(m, int(T)))
        Rs[pos:pos + m] = np.sum(rr[idx], axis=1)
        pos += m

    losses = -Rs
    v = _np_quantile_linear(losses, q_loss)
    v = max(0.0, float(v))
    return {"ok": True, "var": v}
