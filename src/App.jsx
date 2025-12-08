import React, { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { motion, AnimatePresence } from "framer-motion";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import clsx from "clsx";

import "katex/dist/katex.css";
import { InlineMath, BlockMath } from "react-katex";

import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// PDF export (manual)
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

import VarWorker from "./workers/varWorker?worker";
import testData from "./data/testData.json";

// ==================== 颜色调色板（多品种分色） ====================
const PALETTE = [
  "#2563eb", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#06b6d4", "#f97316", "#22c55e",
  "#e11d48", "#0ea5e9", "#84cc16", "#a855f7",
];

// ==================== 用户手册 Markdown（完整口径说明） ====================
const USER_MANUAL_MD = `
# 万能 VaR 计算器用户手册

本工具用于单品种或多品种期货组合在不同方法下的 VaR（Value-at-Risk）估计，并给出价格走势图与详细的参数/口径说明。

---

## 1. 快速开始
1. 点击 **读取 Excel/CSV** 导入数据，或点击 **加载内置数据**。
2. 在 **列映射** 中确认四列：
   - 合约细则ID（品种ID）
   - 合约名称（可选，图例/展示使用）
   - 报价日期
   - 结算价
3. 在左侧设置参数（置信度、持有期、σ 窗口、MC 方法、模拟次数等）。
4. 点击 **开始计算**。
5. 结果依次输出：
   - 文本摘要（含口径与中间拟合值）
   - 表格视图（VaR%）
   - 行情走势图（价格，最近 $w$ 天）

> 数据格式可通过顶部 **下载标准数据模板** 获取。

---

## 2. 数据要求与口径

### 2.1 必要字段
- **合约细则ID**：品种或合约唯一标识，用于分组。
- **合约名称**：可选，仅用于界面展示与图例。
- **报价日期**：交易日日期。
- **结算价**：用于计算收益与绘制价格走势。

### 2.2 对数收益率（计算口径）
程序使用对数收益率：
$$
r_t = \\ln\\left(\\frac{S_t}{S_{t-1}}\\right)
$$
其中 $S_t$ 为第 $t$ 日结算价/收盘价。

---

## 3. 共用参数说明

### 3.1 置信度 $c$
VaR 定义为损失分布的左尾 $(1-c)$ 分位点（取损失为正）：
$$
VaR_{c,T} = -Q_{1-c}(R_T)
$$
常用：
- $c=0.95$（$z=1.645$）
- $c=0.99$（$z=2.330$）

### 3.2 持有期 $T$
持有期以**交易日**计。工具默认给三档：
- $T_1=1$（短期）
- $T_2=5$（一周左右）
- $T_3=22$（一月左右）

在正态假设下，VaR 会按 $\\sqrt{T}$ 放大：
$$
VaR_{c,T} = VaR_{c,1}\\sqrt{T}
$$

### 3.3 σ 窗口 $w$
用于衡量**近期风险水平**的滚动窗口（交易日）：
$$
\\sigma_t = \\mathrm{Std}(r_{t-w+1},\\dots,r_t)
$$
- 正态参数法使用最近 $w$ 天估计 $\\sigma_{\\text{latest}}$。
- Monte Carlo 方法也使用最近 $w$ 天估计 $\\mu_w,\\sigma_w$（或作为 Bootstrap 重采样池）。
- 行情图仅展示最近 $w$ 天价格走势。

**经验推荐：**
- 日频期货：$w=55$（约 1 季度）是平衡“及时性/稳定性”的常用取值。
- 追求更平滑：$w=120$~$250$。
- 若样本不足 $w$，自动退化为全样本估计。

---

## 4. 正态参数 VaR

### 4.1 单品种
假设收益 i.i.d. 正态：
$$
r \\sim \\mathcal N(\\mu,\\sigma^2)
$$
用最近 $w$ 天估计 $\\sigma_{\\text{latest}}$ 后：
$$
VaR_{c,T}= z_c \\cdot \\sigma_{\\text{latest}}\\sqrt{T}
$$
（均值 $\\mu$ 在日频 VaR 中可忽略）

### 4.2 多品种组合
对齐交易日交集后估计相关结构 $\\Sigma$，权重向量 $w$：
$$
\\sigma_p = \\sqrt{w^\\top \\Sigma w}
$$
$$
VaR^{(p)}_{c,T}= z_c \\cdot \\sigma_p\\sqrt{T}
$$

---

## 5. Monte Carlo VaR（最近 $w$ 天口径）

所有 MC 方法输出统一为：
$$
VaR_{c,T} = -Q_{1-c}(R_T)
$$
其中 $R_T$ 为模拟得到的未来 $T$ 天游走累计收益。

### 5.1 Normal MC（正态 i.i.d.）
最近 $w$ 天估计：
$$
r \\sim \\mathcal N(\\mu_w,\\sigma_w^2)
$$
然后独立生成 $K$ 条 $T$ 天路径。

**优点**：快速、稳定、解释性强  
**缺点**：尾部偏薄  
**场景**：常态行情或收益近似正态时的日常风险监控。

### 5.2 t-MC（厚尾 t 分布 + ν 拟合）
最近 $w$ 天拟合 t 分布：
$$
r \\sim t_{\\nu_w}(\\mu_w,\\sigma_w)
$$
程序自动拟合自由度 $\\nu_w$（输出到结果中）。

**优点**：尾部更厚，适合极端风险  
**缺点**：拟合依赖样本量、计算更慢  
**场景**：波动聚集、跳跃明显、尾部厚的期货品种。

#### t ν 搜索上限 $\\nu_{\\max}$
拟合时搜索区间为 $[2,\\nu_{\\max}]$。$\\nu$ 越小尾越厚；$\\nu\\to\\infty$ 逼近正态。

**如何设置：**
- 默认 $\\nu_{\\max}=60$：适用于大多数日频期货（有厚尾但不会极端到需要很大上限）。
- 若样本 **很厚尾/危机期数据多**：可用 $\\nu_{\\max}=30\\sim 60$，避免无意义地拟合到近正态。
- 若品种**非常稳定、尾部接近正态**：可提高到 $\\nu_{\\max}=100\\sim 200$，让拟合有空间趋近正态。
- 样本量较小（<100）时不宜设置太大（建议 $\\le 60$），否则拟合不稳。

### 5.3 Bootstrap MC（历史重采样）
从最近 $w$ 天收益池重采样：
$$
r_t^{(k)} \\leftarrow \\mathrm{sample}(\\{r_{t-w+1},\\dots,r_t\\})
$$

---

## 6. 各方法适用场景与优劣对比

### 6.1 正态参数法（Normal / Parametric VaR）
**核心假设**：收益率近似正态 i.i.d.，风险完全由近期波动率 $\\sigma$ 决定。  
**口径**：最近 $w$ 天估计 $\\sigma_{\\text{latest}}$，再乘 $z$ 与 $\\sqrt{T}$。

**适用场景**
- **日常风险监控 / 常态市场**：价格波动稳定、极端跳跃少。
- **样本不长但希望快速出结果**：只依赖 $w$ 天波动率。
- **主要关心“近期波动是否上升”**：风控阈值、保证金预警。

**优点**
- 速度最快、稳定、解释性最强（$z\\sigma\\sqrt{T}$）。
- 对 $w$ 变化敏感，能快速反映近期风险升温。

**缺点**
- 对厚尾/偏度不敏感，极端行情下可能低估尾部风险。
- 无法体现收益分布形状变化。

---

### 6.2 Normal MC（正态 Monte Carlo）
**核心假设**：收益正态 i.i.d.；用模拟代替闭式公式。  
**口径**：最近 $w$ 天估 $\\mu_w,\\sigma_w$ 后模拟未来路径。

**适用场景**
- **希望保留均值 $\mu$ 的影响**（品种有趋势或漂移时）。
- **需要路径级结果**（未来可能加入止损/触发规则等）。
- **作为正态参数法的验证**：同口径下两者应非常接近。

**优点**
- 与参数法同假设下结果一致，但扩展性更强。
- 易升级到更复杂的路径/组合结构。

**缺点**
- 尾部仍是正态，极端风险低估问题依旧存在。
- 计算慢于参数法（但实现已做 worker 并行）。

---

### 6.3 t-MC（厚尾 t 分布 MC）
**核心假设**：收益服从 t 分布，允许厚尾；$\\nu$ 自动拟合。  
**口径**：最近 $w$ 天拟合 $\\mu_w,\\sigma_w,\\nu_w$ 后模拟。

**适用场景**
- **明显厚尾或跳跃品种**（黑色/化工/高波动品种等）。
- **危机/波动聚集阶段**：$\\nu$ 会显著变小，VaR 更保守。
- **你要对极端损失更敏感**（压力测试、保守风控口径）。

**优点**
- 能显式刻画尾部厚度（$\\nu$），比正态更贴近大量期货收益特征。
- $\nu$ 本身可被视为风险状态指标。

**缺点**
- 拟合依赖样本量；$w$ 太短不稳、太长不敏感。
- 计算量最大。

---

### 6.4 Bootstrap MC（历史重采样）
**核心假设**：不作分布假设；未来收益来自近期历史的重抽样。  
**口径**：从最近 $w$ 天收益池重采样拼接路径。

**适用场景**
- **不信任何参数分布假设**（偏度/峰度/尾部结构复杂）。
- **希望最大程度保留真实分布形状**（跳跃、偏度、厚尾等）。
- **作为分布假设方法的对照组**：校验 Normal/t-MC 假设偏差。

**优点**
- 最少假设，完全“历史驱动”。
- 对偏度、肥尾、离群点非常敏感（若样本中存在）。

**缺点**
- 尾部可靠性取决于 $w$ 内是否出现极端日：  
  若样本缺少极端事件，Bootstrap 可能低估尾部。
- 无外推能力（不会产生历史未出现的极端值）。

---

### 6.5 如何公平对比这些方法？
当前版本已统一口径（MC 也用最近 $w$ 天），因此可直接横向对比：

- **正态参数法 ≈ Normal MC**  
  同 $w$ + 同正态假设 → 两者应高度一致（差异来自 MC 采样误差/是否带 $\\mu$）。

- **t-MC 通常 ≥ Normal MC**  
  若显著更大 → 厚尾/极端风险提升；  
  若接近 → 近期分布接近正态（$\\nu$ 拟合会偏大）。

- **Bootstrap 取决于 $w$ 内极端日是否出现**  
  Bootstrap 大而 Normal/t-MC 小 → 最近确实发生极端事件；  
  Bootstrap 小而 t-MC 大 → 历史未出现极端日，但形状提示厚尾。

---

### 6.6 选法小抄（给用户的快速建议）
- **日常监控 / 常态行情**：  
  ✅ 正态参数法（最快）  
  ✅ Normal MC（若你希望保留路径/μ）

- **高波动 / 跳跃 / 危机阶段**：  
  ✅ t-MC（主口径）  
  ➕ Bootstrap（对照：极端日是否真实发生）

- **完全历史驱动 / 不做假设**：  
  ✅ Bootstrap MC  
  ➕ t-MC（厚尾外推对照）

- **风控口径要保守**：  
  ✅ t-MC + Bootstrap  
  正态类作为下限参考

---

## 7. 结果解读
- **VaR%** 表示未来 $T$ 天在置信度 $c$ 下的最大预期损失比例。
- 当 Normal MC 和 正态参数法同口径（最近 $w$ 天 + 正态）时，两者应非常接近；差异主要来自 MC 采样误差或均值项。
- 若 t-MC 明显大于 Normal MC，说明近期收益尾部更厚、极端风险更显著。

---

## 8. 常见问题
**Q1：组合提示对齐日期太少？**  
A：参与品种交易日交集太少，请减少品种或换重叠更多的品种。

**Q2：t-MC 拟合的 $\nu$ 很小？**  
A：近期极端波动显著、尾厚。可结合 Bootstrap 验证。

**Q3：MC 结果不够稳定？**  
A：提高模拟次数 $K$（如 200k→500k）或适当增大 $w$。

`;

// ==================== 帮助文案（逐参完整解释） ====================
const HELP_TEXT = {
  idCol:
    "品种/合约的唯一标识列，用于区分不同期货品种。多品种组合时按该列分组。",
  nameCol:
    "合约名称列（可选）。仅用于显示在图例/下拉中，不参与任何计算。",
  dateCol:
    "交易日期列。多品种组合计算会按日期对齐，相关性和组合收益只使用对齐后的有效交集交易日。",
  priceCol:
    "结算价/收盘价列。程序先用该列计算对数收益：$r_t=\\ln(S_t/S_{t-1})$。行情图也使用该列绘制。",

  conf1:
    "置信度 $c_1$（如 0.95）。VaR 为未来 $T$ 天损失分布的左尾 $(1-c)$ 分位点：$VaR=-Q_{1-c}(R_T)$。",
  conf2:
    "置信度 $c_2$（如 0.99），对应更极端的尾部风险衡量。",
  T1:
    "持有期 $T_1$（交易日）。短期风险口径，默认 1 天。",
  T2:
    "持有期 $T_2$（交易日）。中期口径，默认 5 天。",
  T3:
    "持有期 $T_3$（交易日）。长期口径，默认 22 天。",
  window:
    "σ 窗口 $w$（交易日）。用于估计近期波动率：$\\sigma_t=\\text{Std}(r_{t-w+1},...,r_t)$。本工具中：\n" +
    "• 正态参数法用 $\\sigma_{latest}(w)$。\n" +
    "• MC 方法也用最近 $w$ 天估 $\\mu_w,\\sigma_w$（Bootstrap 则以最近 $w$ 天为采样池）。\n" +
    "• 行情图仅展示最近 $w$ 天价格。",
  mcMethod:
    "Monte Carlo 方法：\n" +
    "• Normal：假设收益正态 i.i.d.，用最近 $w$ 天估参数后模拟。\n" +
    "• t-MC：假设收益服从 t 分布并拟合自由度 $\\nu$，更能刻画厚尾。\n" +
    "• Bootstrap：从最近 $w$ 天历史收益重采样拼路径，无分布假设。",
  sims:
    "模拟次数 $K$。每次生成 $K$ 条未来 $T$ 天收益路径，取左尾分位作为 VaR。$K$ 越大结果越稳定，但计算更久。",
  dfMax:
    "t 分布自由度搜索上限 $\\nu_{max}$。拟合区间为 $[2,\\nu_{max}]$。\n" +
    "推荐设置：\n" +
    "• 常规日频期货：$\\nu_{max}=60$（默认）。\n" +
    "• 明显厚尾/危机期样本多：30~60。\n" +
    "• 尾部接近正态、样本很长：100~200。\n" +
    "• 样本较短（<100），不建议超过 60。",
  mode:
    "计算模式：\n" +
    "• 单品种：对某一品种计算 VaR。\n" +
    "• 多品种组合：按日期对齐后估相关结构，再按权重计算组合 VaR。",
  singleId:
    "单品种模式下选择一个品种进行 VaR 估计。",
  portfolioIds:
    "多品种组合选取列表。组合 VaR 只使用对齐后的有效交集日期；交集太少会提示失败。",
  weightsText:
    "组合权重向量输入。格式：“品种=权重,品种=权重…”。若不填则等权。程序会自动归一化，使权重和为 1。",
};

// ==================== KaTeX 渲染器 ====================
// ==================== KaTeX 渲染器（用于问号帮助） ====================
const renderTip = (tip) => {
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <p className="my-1">{children}</p>,
          li: ({ children }) => <li className="ml-4 list-disc">{children}</li>,
        }}
      >
        {String(tip)}
      </ReactMarkdown>
    </div>
  );
};


// ==================== Portal + 防越界 Help 组件 ====================
const Help = ({ tip }) => {
  const iconRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState({ x: 0, y: 0, place: "bottom" });

  const computePos = React.useCallback(() => {
    const el = iconRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const bubbleW = 320;
    const bubbleH = 220;
    const padding = 8;

    let x = rect.left + rect.width / 2;
    let y = rect.bottom + 10;
    let place = "bottom";

    const minX = padding + bubbleW / 2;
    const maxX = vw - padding - bubbleW / 2;
    x = Math.min(Math.max(x, minX), maxX);

    if (y + bubbleH > vh - padding) {
      y = rect.top - 10;
      place = "top";
    }

    setPos({ x, y, place });
  }, []);

  const openTip = () => {
    computePos();
    setOpen(true);
  };
  const closeTip = () => setOpen(false);

  React.useEffect(() => {
    if (!open) return;
    const onRecalc = () => computePos();
    window.addEventListener("resize", onRecalc);
    window.addEventListener("scroll", onRecalc, true);
    return () => {
      window.removeEventListener("resize", onRecalc);
      window.removeEventListener("scroll", onRecalc, true);
    };
  }, [open, computePos]);

  return (
    <>
      <span
        ref={iconRef}
        onMouseEnter={openTip}
        onMouseLeave={closeTip}
        className="inline-flex items-center ml-1 align-middle"
      >
        <span
          className="w-4 h-4 inline-flex items-center justify-center rounded-full
                     bg-slate-100 text-slate-600 text-[10px] font-bold border border-slate-300
                     cursor-help hover:bg-slate-900 hover:text-white transition"
        >
          ?
        </span>
      </span>

      {open &&
        createPortal(
          <div
            className="fixed z-[2147483647] w-[320px] max-w-[85vw]
                       rounded-xl bg-slate-900 text-white text-xs leading-relaxed
                       px-3 py-2 shadow-2xl whitespace-pre-wrap
                       animate-in fade-in zoom-in-95"
            style={{
              left: pos.x,
              top: pos.y,
              transform:
                pos.place === "bottom"
                  ? "translate(-50%, 0)"
                  : "translate(-50%, -100%)",
            }}
          >
            {renderTip(tip)}
            <div
              className="absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-900 rotate-45"
              style={pos.place === "bottom" ? { top: -4 } : { bottom: -4 }}
            />
          </div>,
          document.body
        )}
    </>
  );
};

// ==================== 计算函数 ====================
function zFromConf(conf) {
  if (Math.abs(conf - 0.95) < 1e-6) return 1.645;
  if (Math.abs(conf - 0.99) < 1e-6) return 2.33;
  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
  const b = [-8.4735109309, 23.08336743743, -21.06224101826, 3.13082909833];
  const c = [
    0.3374754822726147, 0.9761690190917186, 0.1607979714918209,
    0.0276438810333863, 0.0038405729373609, 0.0003951896511919,
    0.0000321767881768, 0.0000002888167364, 0.0000003960315187,
  ];
  const y = conf - 0.5;
  if (Math.abs(y) < 0.42) {
    const r = y * y;
    const num = y * (((a[3] * r + a[2]) * r + a[1]) * r + a[0]);
    const den = ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1.0);
    return num / den;
  }
  let r = y <= 0 ? conf : 1 - conf;
  r = Math.log(-Math.log(r));
  let x = c[0];
  for (let i = 1; i < c.length; i++) x += c[i] * Math.pow(r, i);
  return y > 0 ? x : -x;
}

function latestSigmaRolling(logRetArr, window = 55) {
  const hist = logRetArr.filter((v) => Number.isFinite(v));
  if (hist.length < 2) return NaN;
  const sub = hist.length < window ? hist : hist.slice(-window);
  const m = sub.reduce((a, b) => a + b, 0) / sub.length;
  let s = 0;
  for (const v of sub) {
    const d = v - m;
    s += d * d;
  }
  return Math.sqrt(s / (sub.length - 1));
}

function meanStd(arr) {
  const a = arr.filter(Number.isFinite);
  const mu = a.reduce((s, v) => s + v, 0) / a.length;
  let ss = 0;
  for (const v of a) {
    const d = v - mu;
    ss += d * d;
  }
  const sigma = Math.sqrt(ss / (a.length - 1));
  return { mu, sigma };
}

function normalVarSingle(logRetArr, conf, T, window) {
  const z = zFromConf(conf);
  const sigma = latestSigmaRolling(logRetArr, window);
  if (!Number.isFinite(sigma)) return { var: NaN, sigma, z };
  return { var: z * sigma * Math.sqrt(T), sigma, z };
}

function alignedWideReturns(grouped) {
  const ids = Object.keys(grouped);
  const mapById = {};
  ids.forEach((id) => {
    const m = new Map();
    grouped[id].forEach((r) => {
      const key = +r.date;
      m.set(key, r.logRet);
    });
    mapById[id] = m;
  });

  const dateKeys = ids.reduce((acc, id) => {
    const s = new Set(mapById[id].keys());
    if (acc == null) return s;
    return new Set([...acc].filter((k) => s.has(k)));
  }, null);

  const alignedKeys = [...dateKeys].sort((a, b) => a - b);

  return alignedKeys.map((k) => {
    const row = { date: new Date(k) };
    ids.forEach((id) => (row[id] = mapById[id].get(k)));
    return row;
  });
}

function alignedWidePrices(grouped) {
  const ids = Object.keys(grouped);
  const mapById = {};
  ids.forEach((id) => {
    const m = new Map();
    grouped[id].forEach((r) => {
      const key = +r.date;
      m.set(key, r.price);
    });
    mapById[id] = m;
  });

  const allKeysSet = new Set();
  ids.forEach((id) => {
    for (const k of mapById[id].keys()) allKeysSet.add(k);
  });
  const keys = [...allKeysSet].sort((a, b) => a - b);

  const lastById = Object.fromEntries(ids.map((id) => [id, null]));

  return keys.map((k) => {
    const row = { date: new Date(k) };
    ids.forEach((id) => {
      const raw = mapById[id].get(k);
      if (Number.isFinite(raw) && raw !== 0) {
        lastById[id] = raw;
        row[id] = raw;
      } else {
        row[id] = lastById[id];
      }
    });
    return row;
  });
}

function corrMatrix(rows, ids) {
  const n = rows.length;
  const cols = ids.map((id) => rows.map((r) => r[id]));
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => {
    const m = mean(arr);
    let s = 0;
    for (const v of arr) {
      const d = v - m;
      s += d * d;
    }
    return Math.sqrt(s / (arr.length - 1));
  };
  const mus = cols.map(mean);
  const sigs = cols.map(std);

  const corr = ids.map(() => ids.map(() => 0));
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      let cov = 0;
      for (let k = 0; k < n; k++) {
        cov += (cols[i][k] - mus[i]) * (cols[j][k] - mus[j]);
      }
      cov /= n - 1;
      corr[i][j] = cov / (sigs[i] * sigs[j]);
    }
  }
  return corr;
}

function normalVarPortfolio(grouped, conf, T, window, weights) {
  const ids = Object.keys(grouped);
  const m = ids.length;
  const w = ids.map((id) => weights?.[id] ?? 1 / m);

  const sigmas = ids.map((id) => {
    const arr = grouped[id].map((x) => x.logRet);
    return latestSigmaRolling(arr, window);
  });

  let wide = alignedWideReturns(grouped);
  wide = wide.filter((row) => ids.every((id) => Number.isFinite(row[id])));

  if (wide.length < 2) return { var: NaN, sigmas, corr: null };

  const corr = corrMatrix(wide, ids);

  let sigmaP2 = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      sigmaP2 += w[i] * w[j] * sigmas[i] * sigmas[j] * corr[i][j];
    }
  }
  const sigmaP = Math.sqrt(sigmaP2);
  const z = zFromConf(conf);

  return { var: z * sigmaP * Math.sqrt(T), sigmas, corr, sigmaP, z };
}

// ==================== UI 小组件 ====================
const Card = ({ title, children, className }) => (
  <motion.div
    layout
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.25 }}
    className={clsx(
      "bg-white/80 backdrop-blur rounded-2xl shadow-sm border border-slate-200 p-4",
      className
    )}
  >
    {title && <div className="font-semibold text-slate-800 mb-3">{title}</div>}
    {children}
  </motion.div>
);

const SectionCard = ({ id, title, openSection, setOpenSection, children }) => {
  const isOpen = openSection === id;
  return (
    <Card
      title={
        <button
          type="button"
          onClick={() => setOpenSection(isOpen ? "" : id)}
          className="w-full flex items-center justify-between text-left"
        >
          <span>{title}</span>
          <span className="lg:hidden text-slate-400">
            {isOpen ? "收起" : "展开"}
          </span>
        </button>
      }
      className="p-0"
    >
      <div
        className={clsx(
          "px-4 pb-4",
          "lg:block",
          isOpen ? "block" : "hidden"
        )}
      >
        {children}
      </div>
    </Card>
  );
};

const Field = ({ label, children }) => (
  <label className="grid grid-cols-1 sm:grid-cols-2 items-center gap-2 sm:gap-3 text-sm">
    <span className="text-slate-600">{label}</span>
    {children}
  </label>
);

// ==================== 进度遮罩 ====================
const ProgressOverlay = ({ open, text = "计算中…" }) => {
  if (!open) return null;
  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[9999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className="w-full max-w-[92vw] sm:max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 p-6"
          initial={{ scale: 0.96, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 8 }}
          transition={{ duration: 0.2 }}
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full border-4 border-slate-200 border-t-slate-900 animate-spin" />
            <div>
              <div className="font-semibold text-slate-900">正在计算 VaR</div>
              <div className="text-sm text-slate-600 mt-0.5">{text}</div>
            </div>
          </div>

          <div className="mt-5 h-3 w-full rounded-full bg-slate-100 overflow-hidden">
            <motion.div
              className="h-full w-1/2 rounded-full bg-gradient-to-r from-slate-900 via-slate-700 to-slate-900"
              initial={{ x: "-100%" }}
              animate={{ x: "200%" }}
              transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
            />
          </div>

          <div className="text-xs text-slate-500 mt-3">
            请勿关闭页面，计算完成后会自动恢复操作。
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
};

const SymbolSelectorModal = ({
  open,
  onClose,
  mode,
  ids,
  idToName,
  singleId,
  setSingleId,
  portfolioIds,
  setPortfolioIds,
  selectorSearch,
  setSelectorSearch,
}) => {
  if (!open) return null;

  const inputRef = React.useRef(null);
  const isComposingRef = React.useRef(false);

  React.useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const q = selectorSearch.trim();
  const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];

  const filtered =
    tokens.length === 0
      ? ids
      : ids.filter((id) => {
          const name = idToName[id] || "";
          const hay = (id + " " + name).toLowerCase();
          return tokens.every((t) => hay.includes(t));
        });

  const togglePortfolio = (id) => {
    setPortfolioIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white w-[92vw] max-w-3xl rounded-lg shadow-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">
            {mode === "single" ? "选择单品种" : "选择组合品种"}
          </div>
          <button
            className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
            onClick={onClose}
            onMouseDown={(e) => e.preventDefault()}
          >
            关闭
          </button>
        </div>

        <input
          ref={inputRef}
          value={selectorSearch}
          placeholder="搜索品种代码/合约名称（支持中文）"
          className="border rounded px-2 py-1 w-full"
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            // 组合结束，允许后续正常 onChange
            isComposingRef.current = false;
            // 再补一次最终值（有些输入法不会在 end 后再触发 change）
            setSelectorSearch(e.target.value);
          }}
          onChange={(e) => {
            // ✅ 组合态也要更新 state，让中文拼音能上屏
            setSelectorSearch(e.target.value);
          }}
        />


        {mode === "portfolio" && (
          <div className="flex gap-2 text-sm">
            <button
              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
              onClick={() => setPortfolioIds([])}
              onMouseDown={(e) => e.preventDefault()}
            >
              全不选
            </button>
            <button
              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
              onClick={() => setPortfolioIds(ids.slice())}
              onMouseDown={(e) => e.preventDefault()}
            >
              全选
            </button>
            <div className="text-gray-500 self-center">
              已选 {portfolioIds.length} / {ids.length}
            </div>
          </div>
        )}

        <div className="border rounded p-2 max-h-[60vh] overflow-auto space-y-1">
          {filtered.length === 0 && (
            <div className="text-sm text-gray-500">没有匹配的品种</div>
          )}

          {mode === "single" &&
            filtered.map((id) => {
              const label = idToName[id]
                ? `${id}（${idToName[id]}）`
                : id;
              const active = singleId === id;
              return (
                <button
                  key={id}
                  className={clsx(
                    "w-full text-left px-2 py-1 rounded hover:bg-gray-50",
                    active && "bg-blue-50 border border-blue-200"
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSingleId(id);
                    onClose();
                  }}
                >
                  {label}
                </button>
              );
            })}

          {mode === "portfolio" &&
            filtered.map((id) => {
              const label = idToName[id]
                ? `${id}（${idToName[id]}）`
                : id;
              const checked = portfolioIds.includes(id);
              return (
                <label
                  key={id}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePortfolio(id)}
                  />
                  <span>{label}</span>
                </label>
              );
            })}
        </div>

        {mode === "portfolio" && (
          <div className="flex justify-end">
            <button
              className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClose}
            >
              确认选择
            </button>
          </div>
        )}
      </div>
    </div>
  );
};


// ==================== 主 App ====================
export default function App() {
  const workerRef = useRef(null);
  if (!workerRef.current) workerRef.current = new VarWorker();

  const chartRef = useRef(null);
  const manualBodyRef = useRef(null);

  const [rawRows, setRawRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [fileName, setFileName] = useState("");

  const [idCol, setIdCol] = useState("");
  const [nameCol, setNameCol] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [priceCol, setPriceCol] = useState("");

  const [conf1, setConf1] = useState(0.95);
  const [conf2, setConf2] = useState(0.99);
  const [T1, setT1] = useState(1);
  const [T2, setT2] = useState(5);
  const [T3, setT3] = useState(22);
  const [window, setWindow] = useState(55);

  const [mcMethod, setMcMethod] = useState("normal"); // normal | t_mc | bootstrap
  const [sims, setSims] = useState(200000);
  const [dfMax, setDfMax] = useState(60);

  const [mode, setMode] = useState("single");
  const [singleId, setSingleId] = useState("");
  const [portfolioIds, setPortfolioIds] = useState([]);
  const [weightsText, setWeightsText] = useState("");

  // 选择弹窗
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectorSearch, setSelectorSearch] = useState("");

  // 权重弹窗（多品种）
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [weightsById, setWeightsById] = useState({});


  const [showManual, setShowManual] = useState(false);
  const [openSection, setOpenSection] = useState("data");

  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [resultRows, setResultRows] = useState([]);
  const [summary, setSummary] = useState("");

  const [priceSeries, setPriceSeries] = useState([]);
  const [priceSeriesIds, setPriceSeriesIds] = useState([]);

  const [lastCalcMode, setLastCalcMode] = useState("single"); // 记录上一次“开始计算”的模式

  const [idToName, setIdToName] = useState({});

  // ============ 标准模板下载（含3行样例） ============
  const downloadTemplate = () => {
    const sample = [
      {
        "合约细则ID": "CFI",
        "合约名称": "棉花指数",
        "报价日期": "2024-01-02",
        "结算价": 15250,
      },
      {
        "合约细则ID": "CFI",
        "合约名称": "棉花指数",
        "报价日期": "2024-01-03",
        "结算价": 15310,
      },
      {
        "合约细则ID": "RBFI",
        "合约名称": "螺纹钢指数",
        "报价日期": "2024-01-02",
        "结算价": 3612,
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sample, { skipHeader: false });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "模板");
    XLSX.writeFile(wb, "VaR标准数据模板.xlsx");
  };

  // ============ 文件读取 ============
  const onFile = async (file) => {
    setFileName(file.name);
    const buf = await file.arrayBuffer();
    let rows = [];
    if (file.name.endsWith(".csv")) {
      const txt = new TextDecoder("utf-8").decode(buf);
      const parsed = Papa.parse(txt, { header: true });
      rows = parsed.data.filter((r) => Object.keys(r).length);
    } else {
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    }
    setRawRows(rows);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    setColumns(cols);
    autoSetColumns(cols);
  };

  const loadTestData = () => {
    setFileName("内置测试数据 testData.json");
    setRawRows(testData);
    const cols = testData.length ? Object.keys(testData[0]) : [];
    setColumns(cols);
    autoSetColumns(cols);
  };

  const autoSetColumns = (cols) => {
    const autoPick = (cands) => {
      for (const c of cands) if (cols.includes(c)) return c;
      return "";
    };
    const _id = autoPick(["合约细则ID", "品种", "symbol", "ID"]);
    const _name = autoPick(["合约名称", "合约细则描述", "name", "品种名称"]);
    const _date = autoPick(["报价日期", "日期", "date", "交易日"]);
    const _price = autoPick(["结算价", "价格", "settle", "close"]);
    setIdCol(_id || cols[0] || "");
    setNameCol(_name || "");
    setDateCol(_date || cols[0] || "");
    setPriceCol(_price || cols[0] || "");
  };

  // 统一数字解析：支持 "10,795.00" / " 10795 " / 数字本体
  const toNumber = (v) => {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/,/g, "");
    if (!s) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };

  const toDate = (v) => {
    if (v == null) return new Date("invalid");
    const s = String(v).trim();
    // 兼容 2024/01/02 或 2024-01-02
    if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(s)) {
      return new Date(s.replace(/\//g, "-"));
    }
    // 兼容 MM/DD/YY
    if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(s)) {
      const [mm, dd, yy] = s.split("/").map(Number);
      const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy; // 常见金融数据规则
      return new Date(yyyy, mm - 1, dd);
    }
    return new Date(s);
  };

  // ============ 数据预处理（含名称映射） ============
  const { groupedAll, idsAll } = useMemo(() => {
    if (!rawRows.length || !idCol || !dateCol || !priceCol)
      return { groupedAll: {}, idsAll: [] };

    const cleaned = rawRows
      .map((r) => ({
        id: String(r[idCol]),
        name: nameCol ? String(r[nameCol] ?? "") : "",
        date: toDate(r[dateCol]),
        price: toNumber(r[priceCol]),
      }))
      .filter(
        (r) =>
          r.id &&
          Number.isFinite(r.date.getTime()) &&
          Number.isFinite(r.price) &&
          r.price > 0
      )
      .sort((a, b) => a.id.localeCompare(b.id) || a.date - b.date);

    const tmp = [];
    for (let i = 0; i < cleaned.length; i++) {
      const cur = cleaned[i];
      const prev = tmp[tmp.length - 1];
      if (
        prev &&
        prev.id === cur.id &&
        prev.date.getTime() === cur.date.getTime()
      ) {
        tmp[tmp.length - 1] = cur;
      } else tmp.push(cur);
    }

    const nameMap = {};
    for (const row of tmp) {
      if (row.name && !nameMap[row.id]) nameMap[row.id] = row.name;
    }
    setIdToName(nameMap);

    const grouped = {};
    for (const row of tmp) {
      if (!grouped[row.id]) grouped[row.id] = [];
      grouped[row.id].push(row);
    }

    const retGrouped = {};
    for (const id of Object.keys(grouped)) {
      const arr = grouped[id];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const prev = arr[i - 1];
        const lr = prev ? Math.log(arr[i].price / prev.price) : NaN;
        out.push({ ...arr[i], logRet: lr });
      }
      retGrouped[id] = out;
    }

    return { groupedAll: retGrouped, idsAll: Object.keys(retGrouped) };
  }, [rawRows, idCol, nameCol, dateCol, priceCol]);

  React.useEffect(() => {
    if (idsAll.length) {
      // 单品种可以默认第一个（也可以改成 ""）
      setSingleId(idsAll[0]);
      // 多品种默认全不选
      setPortfolioIds([]);
      setWeightsText("");
    }
  }, [idsAll.join("|")]);

  // 当多品种选择变化时初始化/清理权重
  React.useEffect(() => {
    if (mode !== "portfolio") return;
    setWeightsById((prev) => {
      const next = { ...prev };
      portfolioIds.forEach((id) => {
        if (next[id] == null || !Number.isFinite(next[id])) next[id] = 1;
      });
      Object.keys(next).forEach((id) => {
        if (!portfolioIds.includes(id)) delete next[id];
      });
      return next;
    });
  }, [mode, portfolioIds.join("|")]);



  const parseWeights = (ids) => {
    if (!ids.length) return {};

    const arr = ids.map((id) => toNumber(weightsById[id]));
    const hasAny = arr.some(Number.isFinite);

    if (!hasAny) {
      const w = 1 / ids.length;
      return Object.fromEntries(ids.map((id) => [id, w]));
    }

    if (arr.some((x) => !Number.isFinite(x))) {
      throw new Error("有品种权重为空或非数字，请在权重弹窗中补全");
    }

    const s = arr.reduce((a, b) => a + b, 0);
    if (s <= 0) throw new Error("权重和必须大于 0");

    const norm = {};
    ids.forEach((id, i) => (norm[id] = arr[i] / s));
    return norm;
  };

  const fmtPct2 = (v) =>
    Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";

  // ============ 导出结果（Excel 内含摘要 / 表格 / 价格数据 / 走势图） ============
  const exportResults = () => {
    const wb = XLSX.utils.book_new();

    // Summary
    const summaryLines = (summary || "")
      .split("\n")
      .map((line) => ({ Summary: line }));
    const wsSummary = XLSX.utils.json_to_sheet(summaryLines);
    XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

    // VaR Table
    const wsTable = XLSX.utils.json_to_sheet(resultRows || []);
    XLSX.utils.book_append_sheet(wb, wsTable, "VaR Table");

    // Prices
    const wsPrices = XLSX.utils.json_to_sheet(priceSeries || []);
    XLSX.utils.book_append_sheet(wb, wsPrices, "Prices(last w days)");

    XLSX.writeFile(wb, "VaR_results_with_summary_prices.xlsx");
  };

  // ============ 用户手册下载 PDF（页面内一键） ============
  const downloadManualPDF = async () => {
    try {
      const el = manualBodyRef.current;
      if (!el) {
        alert("未找到手册正文区域，请先打开用户手册后再下载。");
        return;
      }

      const prevHeight = el.style.height;
      const prevOverflow = el.style.overflow;
      el.style.height = "auto";
      el.style.overflow = "visible";

      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
      });

      el.style.height = prevHeight;
      el.style.overflow = prevOverflow;

      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF("p", "mm", "a4");

      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();

      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;

      let y = 0;
      let leftH = imgH;

      pdf.addImage(imgData, "PNG", 0, y, imgW, imgH);
      leftH -= pageH;

      while (leftH > 0) {
        pdf.addPage();
        y = -(imgH - leftH);
        pdf.addImage(imgData, "PNG", 0, y, imgW, imgH);
        leftH -= pageH;
      }

      pdf.save("VaR用户手册.pdf");
    } catch (e) {
      console.error(e);
      alert("PDF 导出失败：" + e.message);
    }
  };

  // ============ 计算入口 ============
  const runCalc = async () => {
    if (!idsAll.length) return;

    setLoading(true);
    setProgressText("预处理中…");
    setResultRows([]);
    setSummary("");
    setPriceSeries([]);
    setPriceSeriesIds([]);

    const confs = [conf1, conf2];
    const Ts = [T1, T2, T3];

    let lines = [];
    let rows = [];
    lines.push(
      `共用参数： c1=${conf1.toFixed(3)}, c2=${conf2.toFixed(
        3
      )} | T1/T2/T3=${T1}/${T2}/${T3} 交易日 | σ窗口=${window}日`
    );
    lines.push(
      `Monte Carlo： 方法=${mcMethod === "t_mc" ? "t-MC" : mcMethod
      } | K=${sims} | ν_max=${dfMax} | 口径=最近${window}日`
    );
    lines.push("");

    const callWorkerSingle = (r, conf, T) =>
      new Promise((resolve) => {
        workerRef.current.onmessage = (e) => resolve(e.data);
        workerRef.current.postMessage({
          task: "mcSingle",
          payload: { r, conf, T, sims, method: mcMethod, dfMax },
        });
      });

    try {
      if (mode === "single") {
        // singleId 为空/失效时，兜底取第一个可用品种
        const cid =
          singleId && groupedAll[singleId]
            ? singleId
            : idsAll.find((id) => groupedAll[id]);

        if (!cid || !groupedAll[cid]) {
          throw new Error("单品种未选择或该品种无有效数据");
        }
        const sub = groupedAll[cid];
        const rAll = sub.map((x) => x.logRet).filter(Number.isFinite);

        const rMC = rAll.length > window ? rAll.slice(-window) : rAll;
        const { mu: muW, sigma: sigmaW } = meanStd(rMC);
        const sigmaLatest = latestSigmaRolling(rAll, window);

        lines.push(`[单品种] ${cid}${idToName[cid] ? `（${idToName[cid]}）` : ""}`);
        lines.push(
          `MC口径(最近${window}日)：μ_w=${muW.toFixed(6)}, σ_w=${sigmaW.toFixed(6)}`
        );
        lines.push(`最新 σ_latest(窗口) = ${sigmaLatest.toFixed(6)}\n`);

        // 正态参数
        lines.push("— 正态参数 VaR（收益率口径）—");
        for (const c of confs) {
          const z = zFromConf(c);
          const vList = Ts.map((T) => normalVarSingle(rAll, c, T, window).var);
          lines.push(
            `  c=${c.toFixed(3)}(z=${z.toFixed(3)}) | ` +
              Ts.map(
                (T, i) =>
                  `T=${T}: ${vList[i].toFixed(6)} (${(vList[i] * 100).toFixed(
                    3
                  )}%)`
              ).join(" | ")
          );
          rows.push({
            method: `正态参数法（${cid}）`,
            conf: c.toFixed(3),
            extra: `z=${z.toFixed(3)} | σ_latest=${sigmaLatest.toFixed(
              6
            )} | window=${window}`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }
        lines.push("");

        // MC
        lines.push(`— 蒙特卡洛 VaR（${mcMethod === "t_mc" ? "t-MC" : mcMethod}；最近${window}日口径）—`);
        for (const c of confs) {
          const z = zFromConf(c);
          const vList = [];
          let nuFit = null;

          for (const T of Ts) {
            setProgressText(`MC 计算中：c=${c.toFixed(3)} T=${T} …`);
            const out = await callWorkerSingle(rMC, c, T);
            vList.push(out.var);
            if (mcMethod === "t_mc") nuFit = out.nu ?? out.df ?? nuFit;
          }

          lines.push(
            `  c=${c.toFixed(3)} | ` +
              Ts.map(
                (T, i) =>
                  `T=${T}: ${vList[i].toFixed(6)} (${(vList[i] * 100).toFixed(
                    3
                  )}%)`
              ).join(" | ") +
              (mcMethod === "t_mc" && nuFit ? ` | ν=${Number(nuFit).toFixed(3)}` : "")
          );

          rows.push({
            method: `${mcMethod === "t_mc" ? "t-MC" : "MC " + mcMethod}（${cid}）`,
            conf: c.toFixed(3),
            extra:
              `z=${z.toFixed(3)} | μ_w=${muW.toFixed(6)} | σ_w=${sigmaW.toFixed(6)}` +
              (mcMethod === "t_mc" && nuFit ? ` | ν=${Number(nuFit).toFixed(3)}` : "") +
              ` | window=${window} | K=${sims}`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }

        // 行情图：最近 window 天
        let last = null;
        const fullSeries = sub
          .map((x) => {
            const p = Number(x.price);
            if (Number.isFinite(p) && p !== 0) last = p;
            const val = Number.isFinite(p) && p !== 0 ? p : last;
            return {
              date: x.date.toISOString().slice(0, 10),
              [cid]: val,
            };
          })
          .filter((x) => Number.isFinite(x[cid]));

        setPriceSeriesIds([cid]);
        setPriceSeries(fullSeries.slice(-window));
        setLastCalcMode(mode);
      } else {
        // ==================== portfolio 模式 ====================
        let ids = portfolioIds;
        if (ids.length < 2) throw new Error("组合品种不足（至少选 2 个）");

        const grouped0 = Object.fromEntries(ids.map((id) => [id, groupedAll[id]]));

        const validIds = ids.filter((id) => {
          const r = grouped0[id].map((x) => x.logRet).filter(Number.isFinite);
          return r.length >= 2;
        });
        if (validIds.length < 2) {
          throw new Error("有效品种不足：至少 2 个品种拥有 >=2 条有效收益率。");
        }

        const grouped = Object.fromEntries(validIds.map((id) => [id, grouped0[id]]));
        const weights = parseWeights(validIds);
        ids = validIds;

        let wideRaw = alignedWideReturns(grouped);
        let wideClean = wideRaw.filter((row) =>
          ids.every((id) => Number.isFinite(row[id]))
        );
        if (wideClean.length < 2) {
          throw new Error(
            "组合对齐后的有效交集日期太少（wideClean<2）。请换一组交易日期重叠更多的品种，或缩小品种范围。"
          );
        }

        const wTxt = ids.map((id) => `${id}=${weights[id].toFixed(3)}`).join(", ");

        lines.push("[多品种组合]");
        lines.push("参与品种： " + ids.join(", "));
        lines.push("权重（归一化后）： " + wTxt);

        // 正态参数组合 VaR
        lines.push("\n— 正态参数 组合 VaR（收益率口径）—");
        for (const c of confs) {
          const outP = Ts.map((T) =>
            normalVarPortfolio(grouped, c, T, window, weights)
          );
          const vList = outP.map((o) => o.var);
          const z = outP[0].z;
          const sigmaP = outP[0].sigmaP;

          lines.push(
            `  c=${c.toFixed(3)}(z=${z.toFixed(3)}) | ` +
              Ts.map(
                (T, i) =>
                  `T=${T}: ${vList[i].toFixed(6)} (${(vList[i] * 100).toFixed(
                    3
                  )}%)`
              ).join(" | ")
          );

          rows.push({
            method: "正态参数法（组合）",
            conf: c.toFixed(3),
            extra: `z=${z.toFixed(3)} | σ_p=${sigmaP.toFixed(
              6
            )} | window=${window} | w=[${wTxt}]`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }

        // 组合 MC：历史组合收益 i.i.d.
        const wVec = ids.map((id) => weights[id]);
        const rpHist = wideClean
          .map((r) => ids.reduce((s, id, i) => s + r[id] * wVec[i], 0))
          .filter(Number.isFinite);

        const rpMC = rpHist.length > window ? rpHist.slice(-window) : rpHist;
        const { mu: muW, sigma: sigmaW } = meanStd(rpMC);

        lines.push(`\n— 蒙特卡洛 组合 VaR（历史组合收益 i.i.d.，${mcMethod === "t_mc" ? "t-MC" : mcMethod}；最近${window}日口径）—`);
        lines.push(`  μ_w=${muW.toFixed(6)}, σ_w=${sigmaW.toFixed(6)}`);

        for (const c of confs) {
          const z = zFromConf(c);
          const vList = [];
          let nuFit = null;

          for (const T of Ts) {
            setProgressText(`组合 MC：c=${c.toFixed(3)} T=${T} …`);
            const out = await callWorkerSingle(rpMC, c, T);
            vList.push(out.var);
            if (mcMethod === "t_mc") nuFit = out.nu ?? out.df ?? nuFit;
          }

          lines.push(
            `  c=${c.toFixed(3)} | ` +
              Ts.map(
                (T, i) =>
                  `T=${T}: ${vList[i].toFixed(6)} (${(vList[i] * 100).toFixed(
                    3
                  )}%)`
              ).join(" | ") +
              (mcMethod === "t_mc" && nuFit ? ` | ν=${Number(nuFit).toFixed(3)}` : "")
          );

          rows.push({
            method: `${mcMethod === "t_mc" ? "t-MC" : "MC " + mcMethod}（组合）`,
            conf: c.toFixed(3),
            extra:
              `z=${z.toFixed(3)} | μ_w=${muW.toFixed(6)} | σ_w=${sigmaW.toFixed(6)}` +
              (mcMethod === "t_mc" && nuFit ? ` | ν=${Number(nuFit).toFixed(3)}` : "") +
              ` | window=${window} | w=[${wTxt}] | K=${sims}`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }

        // 行情图：最近 window 天
        const widePriceFull = alignedWidePrices(grouped).map((row) => ({
          ...row,
          date: row.date.toISOString().slice(0, 10),
        }));

        setPriceSeriesIds(ids);
        setPriceSeries(widePriceFull.slice(-window));
        setLastCalcMode(mode);
      }

      setSummary(lines.join("\n"));
      setResultRows(rows);
    } catch (err) {
      setSummary("计算失败：" + err.message);
    } finally {
      setProgressText("");
      setLoading(false);
    }
  };

  const WeightsModal = ({
    open,
    onClose,
    ids,
    idToName,
    weightsById,
    setWeightsById,
  }) => {
    if (!open) return null;

    const setOne = (id, v) => {
      const n = Number(v);
      setWeightsById((prev) => ({
        ...prev,
        [id]: Number.isFinite(n) ? n : "",
      }));
    };

    const setEqual = () => {
      const next = {};
      ids.forEach((id) => (next[id] = 1));
      setWeightsById(next);
    };

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white w-[92vw] max-w-2xl rounded-lg shadow-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">设置组合权重</div>
            <button
              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
              onClick={onClose}
              onMouseDown={(e) => e.preventDefault()}
            >
              关闭
            </button>
          </div>

          <div className="text-sm text-gray-600">
            当前已选 {ids.length} 个品种
          </div>

          <div className="flex gap-2 text-sm">
            <button
              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
              onClick={setEqual}
              onMouseDown={(e) => e.preventDefault()}
            >
              等权(全部=1)
            </button>
            <button
              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200"
              onClick={() => setWeightsById({})}
              onMouseDown={(e) => e.preventDefault()}
            >
              清空
            </button>
          </div>

          <div className="border rounded p-2 max-h-[60vh] overflow-auto space-y-2">
            {ids.map((id) => {
              const label = idToName[id]
                ? `${id}（${idToName[id]}）`
                : id;
              const val = weightsById[id] ?? "";
              return (
                <div key={id} className="flex items-center gap-2">
                  <div className="flex-1 text-sm">{label}</div>
                  <input
                    className="border rounded px-2 py-1 w-28 text-sm"
                    value={val}
                    onChange={(e) => setOne(id, e.target.value)}
                    placeholder="权重"
                  />
                </div>
              );
            })}
          </div>

          <div className="flex justify-end">
            <button
              className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={onClose}
              onMouseDown={(e) => e.preventDefault()}
            >
              确认
            </button>
          </div>
        </div>
      </div>
    );
  };
// ==================== UI ====================
  return (
    <div className="h-full w-full bg-gradient-to-br from-slate-50 via-white to-slate-100 text-slate-900">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 bg-white/70 backdrop-blur border-b border-slate-200">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="text-lg font-bold tracking-tight">
            万能 VaR 计算器
          </div>

          <button
            onClick={() => setShowManual(true)}
            className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-white border shadow-sm text-xs sm:text-sm hover:bg-slate-50 active:scale-95 transition"
          >
            用户手册
          </button>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              onClick={downloadTemplate}
              className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-white border shadow-sm text-xs sm:text-sm hover:bg-slate-50 active:scale-95 transition"
              title="下载标准数据模板"
            >
              下载标准数据模板
            </button>

            <label className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-slate-900 text-white text-xs sm:text-sm cursor-pointer hover:opacity-90 active:scale-95 transition">
              读取 Excel/CSV
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) =>
                  e.target.files?.[0] && onFile(e.target.files[0])
                }
              />
            </label>

            <button
              onClick={loadTestData}
              className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-white border shadow-sm text-xs sm:text-sm hover:bg-slate-50 active:scale-95 transition"
            >
              加载内置数据（截止2025-12-03）
            </button>

            {resultRows.length > 0 && (
              <button
                onClick={exportResults}
                className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-white border shadow-sm text-xs sm:text-sm hover:bg-slate-50 active:scale-95 transition"
              >
                导出结果
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 主体：只在最外层允许滚动 */}
      <div className="max-w-[1600px] mx-auto h-[calc(100%-56px)] px-4 py-4 overflow-auto">
        <div className="grid grid-cols-12 gap-4">
          {/* 参数区 */}
          <div className="col-span-12 lg:col-span-4 xl:col-span-3 space-y-3 pr-0 lg:pr-1">
            <SectionCard
              id="data"
              title="1. 数据输入"
              openSection={openSection}
              setOpenSection={setOpenSection}
            >
              <div className="text-sm text-slate-600">
                {fileName || "未选择文件"}
              </div>
            </SectionCard>

            <SectionCard
              id="cols"
              title="2. 列映射（自动识别，可手动修改）"
              openSection={openSection}
              setOpenSection={setOpenSection}
            >
              <div className="space-y-2">
                <Field
                  label={
                    <span className="inline-flex items-center">
                      品种ID列 <Help tip={HELP_TEXT.idCol} />
                    </span>
                  }
                >
                  <select
                    className="w-full border rounded-lg px-2 py-1"
                    value={idCol}
                    onChange={(e) => setIdCol(e.target.value)}
                  >
                    {columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      合约名称列（可选） <Help tip={HELP_TEXT.nameCol} />
                    </span>
                  }
                >
                  <select
                    className="w-full border rounded-lg px-2 py-1"
                    value={nameCol}
                    onChange={(e) => setNameCol(e.target.value)}
                  >
                    <option value="">（无）</option>
                    {columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      日期列 <Help tip={HELP_TEXT.dateCol} />
                    </span>
                  }
                >
                  <select
                    className="w-full border rounded-lg px-2 py-1"
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                  >
                    {columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      结算价列 <Help tip={HELP_TEXT.priceCol} />
                    </span>
                  }
                >
                  <select
                    className="w-full border rounded-lg px-2 py-1"
                    value={priceCol}
                    onChange={(e) => setPriceCol(e.target.value)}
                  >
                    {columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </SectionCard>

            <SectionCard
              id="common"
              title="3. 共用参数"
              openSection={openSection}
              setOpenSection={setOpenSection}
            >
              <div className="space-y-2">
                <Field
                  label={
                    <span className="inline-flex items-center">
                      置信度 c1 <Help tip={HELP_TEXT.conf1} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    step="0.001"
                    min="0.8"
                    max="0.999"
                    className="w-full border rounded-lg px-2 py-1"
                    value={conf1}
                    onChange={(e) => setConf1(+e.target.value)}
                  />
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      置信度 c2 <Help tip={HELP_TEXT.conf2} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    step="0.001"
                    min="0.8"
                    max="0.999"
                    className="w-full border rounded-lg px-2 py-1"
                    value={conf2}
                    onChange={(e) => setConf2(+e.target.value)}
                  />
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      短期交易日 T1 <Help tip={HELP_TEXT.T1} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    min="1"
                    className="w-full border rounded-lg px-2 py-1"
                    value={T1}
                    onChange={(e) => setT1(+e.target.value)}
                  />
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      中期交易日 T2 <Help tip={HELP_TEXT.T2} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    min="1"
                    className="w-full border rounded-lg px-2 py-1"
                    value={T2}
                    onChange={(e) => setT2(+e.target.value)}
                  />
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      长期交易日 T3 <Help tip={HELP_TEXT.T3} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    min="1"
                    className="w-full border rounded-lg px-2 py-1"
                    value={T3}
                    onChange={(e) => setT3(+e.target.value)}
                  />
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      σ 窗口（交易日） <Help tip={HELP_TEXT.window} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    min="5"
                    max="500"
                    className="w-full border rounded-lg px-2 py-1"
                    value={window}
                    onChange={(e) => setWindow(+e.target.value)}
                  />
                </Field>
              </div>
            </SectionCard>

            <SectionCard
              id="mc"
              title="4. Monte Carlo 参数"
              openSection={openSection}
              setOpenSection={setOpenSection}
            >
              <div className="space-y-2">
                <Field
                  label={
                    <span className="inline-flex items-center">
                      MC 方法 <Help tip={HELP_TEXT.mcMethod} />
                    </span>
                  }
                >
                  <select
                    className="w-full border rounded-lg px-2 py-1"
                    value={mcMethod}
                    onChange={(e) => setMcMethod(e.target.value)}
                  >
                    <option value="normal">Normal MC（正态）</option>
                    <option value="t_mc">t-MC（厚尾，ν自动拟合）</option>
                    <option value="bootstrap">Bootstrap MC（历史重采样）</option>
                  </select>
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      模拟次数 K <Help tip={HELP_TEXT.sims} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    min="1000"
                    step="10000"
                    className="w-full border rounded-lg px-2 py-1"
                    value={sims}
                    onChange={(e) => setSims(+e.target.value)}
                  />
                </Field>

                <Field
                  label={
                    <span className="inline-flex items-center">
                      t ν 搜索上限 <Help tip={HELP_TEXT.dfMax} />
                    </span>
                  }
                >
                  <input
                    type="number"
                    min="10"
                    max="300"
                    className="w-full border rounded-lg px-2 py-1"
                    value={dfMax}
                    onChange={(e) => setDfMax(+e.target.value)}
                  />
                </Field>
              </div>
            </SectionCard>

            <SectionCard
              id="mode"
              title={
                <span className="inline-flex items-center">
                  5. 计算模式 <Help tip={HELP_TEXT.mode} />
                </span>
              }
              openSection={openSection}
              setOpenSection={setOpenSection}
            >
              <div className="space-y-3">
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode("single")}
                    className={clsx(
                      "px-3 py-1.5 rounded-lg border text-sm transition",
                      mode === "single"
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white hover:bg-slate-50"
                    )}
                  >
                    单品种
                  </button>
                  <button
                    onClick={() => setMode("portfolio")}
                    className={clsx(
                      "px-3 py-1.5 rounded-lg border text-sm transition",
                      mode === "portfolio"
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white hover:bg-slate-50"
                    )}
                  >
                    多品种组合
                  </button>
                </div>

                {mode === "single" && (
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <button
                      className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                      onClick={() => setSelectorOpen(true)}
                      disabled={!idsAll.length}
                    >
                      选择品种
                    </button>

                    <div className="text-gray-700">
                      当前：
                      {singleId
                        ? idToName[singleId]
                          ? `${singleId}（${idToName[singleId]}）`
                          : singleId
                        : "未选择（计算时自动取第一个有效品种）"}
                    </div>
                  </div>
                )}


                {mode === "portfolio" && (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                        onClick={() => setSelectorOpen(true)}
                        disabled={!idsAll.length}
                      >
                        选择品种（可搜索）
                      </button>

                      <button
                        className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200"
                        onClick={() => setPortfolioIds([])}
                      >
                        全不选
                      </button>

                      <div className="text-gray-600">
                        已选 {portfolioIds.length} 个：
                        {portfolioIds.length
                          ? portfolioIds.slice(0, 6).join(", ") +
                            (portfolioIds.length > 6 ? " ..." : "")
                          : "无"}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                        onClick={() => setWeightsOpen(true)}
                        disabled={portfolioIds.length === 0}
                      >
                        设置权重
                      </button>

                      <div className="text-gray-600 text-sm">
                        权重摘要：
                        {portfolioIds.length === 0
                          ? "未选择品种"
                          : portfolioIds
                              .map((id) => {
                                const w = weightsById[id];
                                const show = Number.isFinite(toNumber(w))
                                  ? Number(w).toFixed(3)
                                  : "—";
                                return `${id}:${show}`;
                              })
                              .slice(0, 6)
                              .join(", ") +
                            (portfolioIds.length > 6 ? " ..." : "")}
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </SectionCard>

            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={runCalc}
              disabled={!rawRows.length || loading}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-slate-900 to-slate-700 text-white font-medium shadow
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "计算中…" : "开始计算"}
            </motion.button>
          </div>

          {/* 结果区 */}
          <div className="col-span-12 lg:col-span-8 xl:col-span-9 flex flex-col gap-4">
            <Card title="结果输出（文本摘要）">
              <AnimatePresence mode="wait">
                {!loading ? (
                  <motion.pre
                    key="summary"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-sm whitespace-pre-wrap font-mono text-slate-800"
                  >
                    {summary || "请先读取文件并设置参数。"}
                  </motion.pre>
                ) : (
                  <motion.div key="placeholder" className="text-slate-500 text-sm">
                    计算中…结果将自动更新
                  </motion.div>
                )}
              </AnimatePresence>
            </Card>

            <Card title="结果输出（表格视图）">
              <div className="w-full overflow-x-auto">
                <table className="min-w-[720px] w-full text-sm">
                  <thead className="bg-white">
                    <tr className="text-left border-b">
                      <th className="py-2">方法</th>
                      <th>置信度 c</th>
                      <th>附加参数</th>
                      <th>{`T1 VaR (${T1}天)`}</th>
                      <th>{`T2 VaR (${T2}天)`}</th>
                      <th>{`T3 VaR (${T3}天)`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultRows.map((r, i) => (
                      <tr
                        key={i}
                        className="border-b last:border-0 hover:bg-slate-50 transition"
                      >
                        <td className="py-2">{r.method}</td>
                        <td>{r.conf}</td>
                        <td className="max-w-[360px] truncate" title={r.extra}>
                          {r.extra}
                        </td>
                        <td>{r.v1}</td>
                        <td>{r.v2}</td>
                        <td>{r.v3}</td>
                      </tr>
                    ))}
                    {!resultRows.length && (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          暂无结果
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="text-xs text-slate-500 mt-2">
                表格仅展示 VaR 百分比（保留两位小数）。
              </div>
            </Card>

            <Card title="行情走势图（价格）">
              {lastCalcMode === "portfolio" && priceSeriesIds.length > 8 ? (
                <div className="border rounded p-4 text-sm text-slate-600 bg-slate-50">
                  已选择 {priceSeriesIds.length} 个品种，超过 8 个。为保证展示清晰度，价格走势图已自动隐藏。请将品种数量减少到 8 个及以下再查看价格图。
                </div>
              ) : (
                <>
                  <div ref={chartRef} className="h-[260px] sm:h-[320px] lg:h-[360px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={priceSeries}>
                        <XAxis
                          dataKey="date"
                          tickMargin={8}
                          minTickGap={18}
                          tick={{ fontSize: 10 }}
                        />
                        <YAxis domain={["auto", "auto"]} />
                        <Tooltip />
                        <Legend />
                        {priceSeriesIds.map((id, idx) => (
                          <Line
                            key={id}
                            type="monotone"
                            dataKey={id}
                            dot={false}
                            connectNulls={true}
                            name={idToName[id] ? `${id}（${idToName[id]}）` : id}
                            stroke={PALETTE[idx % PALETTE.length]}
                            strokeWidth={2}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="text-xs text-slate-500 mt-2">
                    仅展示最近 {window} 个交易日的价格走势（0 值/缺失已前向填充）。
                  </div>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>

      {/* 进度遮罩 */}
      <ProgressOverlay open={loading} text={progressText || "Monte Carlo 计算中…"} />

      {/* 用户手册弹窗 */}
      <AnimatePresence>
        {showManual && (
          <motion.div
            className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowManual(false)}
          >
            <motion.div
              className="bg-white rounded-2xl shadow-xl border border-slate-200 
                         w-full max-w-4xl max-h-[90vh] sm:max-h-[85vh] 
                         flex flex-col overflow-hidden"
              initial={{ scale: 0.96, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 8 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 固定头部 */}
              <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center">
                <div className="text-lg font-bold">用户手册</div>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={downloadManualPDF}
                    className="px-3 py-1.5 rounded-lg text-sm border hover:bg-slate-50 active:scale-95 transition"
                  >
                    下载 PDF
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowManual(false)}
                    className="px-3 py-1.5 rounded-lg text-sm border hover:bg-slate-50 active:scale-95 transition"
                  >
                    关闭
                  </button>
                </div>
              </div>

              {/* 只滚动正文 */}
              <div
                ref={manualBodyRef}
                className="manual-body flex-1 overflow-auto px-4 sm:px-6 py-3 sm:py-4"
              >
                <div className="text-slate-900">
                  <ReactMarkdown
                    remarkPlugins={[remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      h1: (p) => (
                        <h1 className="text-2xl font-bold mt-2 mb-4" {...p} />
                      ),
                      h2: (p) => (
                        <h2 className="text-xl font-semibold mt-6 mb-3" {...p} />
                      ),
                      h3: (p) => (
                        <h3 className="text-lg font-semibold mt-4 mb-2" {...p} />
                      ),
                      p: (p) => (
                        <p
                          className="text-sm leading-7 my-2 text-slate-800"
                          {...p}
                        />
                      ),
                      ul: (p) => (
                        <ul
                          className="list-disc pl-5 my-2 space-y-1 text-sm"
                          {...p}
                        />
                      ),
                      ol: (p) => (
                        <ol
                          className="list-decimal pl-5 my-2 space-y-1 text-sm"
                          {...p}
                        />
                      ),
                      li: (p) => <li className="leading-7" {...p} />,
                      blockquote: (p) => (
                        <blockquote
                          className="border-l-4 border-slate-300 pl-3 py-1 my-3 text-slate-600 bg-slate-50 rounded-r"
                          {...p}
                        />
                      ),
                      code: ({ inline, className, children, ...props }) =>
                        inline ? (
                          <code
                            className="px-1 py-0.5 rounded bg-slate-100 text-slate-900 text-[0.9em]"
                            {...props}
                          >
                            {children}
                          </code>
                        ) : (
                          <pre className="bg-slate-900 text-slate-50 rounded-xl p-3 overflow-auto text-xs my-3">
                            <code className={className} {...props}>
                              {children}
                            </code>
                          </pre>
                        ),
                    }}
                  >
                    {USER_MANUAL_MD}
                  </ReactMarkdown>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    <SymbolSelectorModal
      open={selectorOpen}
      onClose={() => setSelectorOpen(false)}
      mode={mode}
      ids={idsAll}
      idToName={idToName}
      singleId={singleId}
      setSingleId={setSingleId}
      portfolioIds={portfolioIds}
      setPortfolioIds={setPortfolioIds}
      selectorSearch={selectorSearch}
      setSelectorSearch={setSelectorSearch}
    />
    <WeightsModal
      open={weightsOpen}
      onClose={() => setWeightsOpen(false)}
      ids={portfolioIds}
      idToName={idToName}
      weightsById={weightsById}
      setWeightsById={setWeightsById}
    />

    </div>
  );
}
