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

import "katex/dist/katex.min.css";
import { InlineMath, BlockMath } from "react-katex";

import VarWorker from "./workers/varWorker?worker";
import testData from "./data/testData.json";

// ==================== 颜色调色板（多品种分色） ====================
const PALETTE = [
  "#2563eb", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#06b6d4", "#f97316", "#22c55e",
  "#e11d48", "#0ea5e9", "#84cc16", "#a855f7",
];

// ==================== 帮助文案（支持 KaTeX：$...$ 行内、$$...$$ 块） ====================
const HELP_TEXT = {
  idCol:
    "品种/合约的唯一标识列，用于区分不同期货品种。多品种组合时按该列分组。",
  dateCol:
    "交易日期列。多品种组合会按日期对齐，相关性与组合收益只使用对齐后的有效日期交集。",
  priceCol:
    "结算价/收盘价列。先用该列计算日对数收益率：$$ r_t = \\ln\\left(\\frac{S_t}{S_{t-1}}\\right). $$",

  conf1:
    "置信度 $c_1$。VaR 为未来 $T$ 天损失分布的左尾 $(1-c)$ 分位点（取损失绝对值）。\n" +
    "$$ VaR_{c,T} = z_c \\cdot \\sigma \\cdot \\sqrt{T}. $$\n" +
    "其中 $z_c$ 为标准正态分位（$c=0.95$ 时 $z=1.645$）。",
  conf2:
    "置信度 $c_2$。常用 $c=0.99$（$z=2.330$），对应更极端的尾部风险。",

  T1:
    "持有期 $T_1$（交易日）。VaR 从 1 天放大到 $T$ 天口径：$$ VaR_{c,T}=VaR_{c,1}\\sqrt{T}. $$",
  T2:
    "持有期 $T_2$（交易日）。示例：5 天。正态参数法：$$ VaR_{c,T} = z_c\\,\\sigma\\sqrt{T}. $$",
  T3:
    "持有期 $T_3$（交易日）。示例：22 天（约 1 个月）。VaR 按 $\\sqrt{T}$ 放大。",

  window:
    "正态参数法的波动率窗口。用最近窗口收益计算滚动波动率：\n" +
    "$$ \\sigma_t = \\text{Std}(r_{t-w+1},\\dots,r_t). $$\n" +
    "若样本不足窗口，则使用全样本标准差。",

  mcMethod:
    "Monte Carlo 方法：\n" +
    "• Normal：假设收益 $r\\sim\\mathcal N(\\mu,\\Sigma)$ 且 i.i.d.，按估计的相关结构模拟路径。\n" +
    "• t_auto：厚尾 $t$ 分布 MC，自动拟合自由度 $\\nu$ 以刻画尾部。\n" +
    "• Bootstrap：历史收益重采样拼路径，减少正态假设。",

  sims:
    "模拟次数 $K$。每次生成 $K$ 条未来 $T$ 天收益路径，取左尾分位作为 VaR。\n" +
    "$$ VaR_{c,T} = - Q_{1-c}(R_T^{(1)},\\dots,R_T^{(K)}). $$\n" +
    "$K$ 越大越稳健但更慢（示例 $K=200{,}000$）。",

  dfMax:
    "t_auto 模式的自由度上限 $\\nu_{\\max}$。$\\nu$ 越小尾部越厚；程序在 $[2,\\nu_{\\max}]$ 内拟合最优 $\\nu$。",

  mode:
    "计算模式：\n" +
    "• 单品种：对单一品种收益计算 VaR。\n" +
    "• 多品种组合：按日期对齐后估计协方差/相关性，再按权重计算组合 VaR。",

  singleId: "单品种模式下选择的目标品种。",

  portfolioIds:
    "多品种组合选取列表。组合 VaR 只使用对齐后的有效交集日期；交集太少会提示失败。",

  weightsText:
    "组合权重向量 $w$（权重和为 1）。默认等权。\n" +
    "组合波动率：$$ \\sigma_p=\\sqrt{w^\\top\\Sigma w}. $$\n" +
    "自定义输入格式：“品种=权重,品种=权重…”，程序自动归一化。",
};

// ==================== KaTeX 渲染器 ====================
const renderTip = (tip) => {
  const parts = String(tip)
    .split(/(\$\$[\s\S]+?\$\$|\$[^$]+\$)/g)
    .filter(Boolean);

  return parts.map((p, i) => {
    if (p.startsWith("$$") && p.endsWith("$$")) {
      return <BlockMath key={i}>{p.slice(2, -2)}</BlockMath>;
    }
    if (p.startsWith("$") && p.endsWith("$")) {
      return <InlineMath key={i}>{p.slice(1, -1)}</InlineMath>;
    }
    return <span key={i}>{p}</span>;
  });
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

    const bubbleW = 300;
    const bubbleH = 180;
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
            className="fixed z-[2147483647] w-[300px] max-w-[85vw]
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

// ==================== 计算函数（对齐你原 Py 逻辑） ====================
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

function normalVarSingle(logRetArr, conf, T, window) {
  const z = zFromConf(conf);
  const sigma = latestSigmaRolling(logRetArr, window);
  if (!Number.isFinite(sigma)) return { var: NaN, sigma };
  return { var: z * sigma * Math.sqrt(T), sigma };
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

  return { var: z * sigmaP * Math.sqrt(T), sigmas, corr };
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

const Field = ({ label, children }) => (
  <label className="grid grid-cols-2 items-center gap-3 text-sm">
    <span className="text-slate-600">{label}</span>
    {children}
  </label>
);

// ==================== 主 App ====================
export default function App() {
  const workerRef = useRef(null);
  if (!workerRef.current) workerRef.current = new VarWorker();

  const [rawRows, setRawRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [fileName, setFileName] = useState("");

  const [idCol, setIdCol] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [priceCol, setPriceCol] = useState("");

  const [conf1, setConf1] = useState(0.95);
  const [conf2, setConf2] = useState(0.99);
  const [T1, setT1] = useState(1);
  const [T2, setT2] = useState(5);
  const [T3, setT3] = useState(22);
  const [window, setWindow] = useState(66);

  const [mcMethod, setMcMethod] = useState("normal");
  const [sims, setSims] = useState(200000);
  const [dfMax, setDfMax] = useState(60);

  const [mode, setMode] = useState("single");
  const [singleId, setSingleId] = useState("");
  const [portfolioIds, setPortfolioIds] = useState([]);
  const [weightsText, setWeightsText] = useState("");

  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [resultRows, setResultRows] = useState([]);
  const [summary, setSummary] = useState("");

  const [priceSeries, setPriceSeries] = useState([]);
  const [priceSeriesIds, setPriceSeriesIds] = useState([]);

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

  // ============ 加载内置测试数据 ============
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
      return cols[0] || "";
    };
    const _id = autoPick(["合约细则ID", "品种", "symbol", "ID"]);
    const _date = autoPick(["报价日期", "日期", "date", "交易日"]);
    const _price = autoPick(["结算价", "价格", "settle", "close"]);
    setIdCol(_id);
    setDateCol(_date);
    setPriceCol(_price);
  };

  // ============ 数据预处理 ============
  const { groupedAll, idsAll } = useMemo(() => {
    if (!rawRows.length || !idCol || !dateCol || !priceCol)
      return { groupedAll: {}, idsAll: [] };

    const cleaned = rawRows
      .map((r) => ({
        id: String(r[idCol]),
        date: new Date(r[dateCol]),
        price: Number(r[priceCol]),
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

    const ids = Object.keys(retGrouped);
    return { groupedAll: retGrouped, idsAll: ids };
  }, [rawRows, idCol, dateCol, priceCol]);

  React.useEffect(() => {
    if (idsAll.length) {
      setSingleId(idsAll[0]);
      setPortfolioIds(idsAll);
    }
  }, [idsAll.join("|")]);

  const parseWeights = (ids) => {
    if (!weightsText.trim()) {
      const w = 1 / ids.length;
      return Object.fromEntries(ids.map((id) => [id, w]));
    }
    try {
      const parts = weightsText
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const w = {};
      for (const p of parts) {
        const [k, v] = p.split("=");
        if (ids.includes(k.trim())) w[k.trim()] = Number(v);
      }
      const s = Object.values(w).reduce((a, b) => a + b, 0);
      if (s <= 0) throw new Error();
      const norm = {};
      ids.forEach((id) => (norm[id] = (w[id] ?? 0) / s));
      return norm;
    } catch {
      const w = 1 / ids.length;
      return Object.fromEntries(ids.map((id) => [id, w]));
    }
  };

  const fmtPct2 = (v) =>
    Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";

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
    lines.push(`========== 计算结果 ==========\n`);
    lines.push(
      `共用参数： c1=${conf1.toFixed(3)}, c2=${conf2.toFixed(
        3
      )} | T1/T2/T3=${T1}/${T2}/${T3} 交易日`
    );
    lines.push(`正态参数法： σ窗口=${window} 交易日`);
    lines.push(`Monte Carlo： 方法=${mcMethod} | K=${sims} | t df_max=${dfMax}`);
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
        const cid = singleId;
        const sub = groupedAll[cid];
        const rAll = sub.map((x) => x.logRet).filter(Number.isFinite);

        const sigmaLatest = latestSigmaRolling(rAll, window);
        lines.push(`[单品种] ${cid}`);
        lines.push(`最新 σ(窗口规则) = ${sigmaLatest.toFixed(6)}\n`);

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

        lines.push(`— 蒙特卡洛 VaR（${mcMethod}）—`);
        for (const c of confs) {
          const vList = [];
          for (const T of Ts) {
            setProgressText(`MC 计算中：c=${c.toFixed(3)} T=${T} …`);
            const out = await callWorkerSingle(rAll, c, T);
            vList.push(out.var);
          }
          lines.push(
            `  c=${c.toFixed(3)} | ` +
              Ts.map(
                (T, i) =>
                  `T=${T}: ${vList[i].toFixed(6)} (${(vList[i] * 100).toFixed(
                    3
                  )}%)`
              ).join(" | ")
          );
          rows.push({
            method: `MC ${mcMethod}（${cid}）`,
            conf: c.toFixed(3),
            extra: `K=${sims}${mcMethod === "t_auto" ? " | ν自动拟合" : ""}`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }

        let last = null;
        const series = sub
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
        setPriceSeries(series);
      } else {
        let ids = portfolioIds;
        if (ids.length < 2) throw new Error("组合品种不足（至少选 2 个）");

        const grouped0 = Object.fromEntries(
          ids.map((id) => [id, groupedAll[id]])
        );

        const validIds = ids.filter((id) => {
          const r = grouped0[id].map((x) => x.logRet).filter(Number.isFinite);
          return r.length >= 2;
        });
        if (validIds.length < 2) {
          throw new Error("有效品种不足：至少 2 个品种拥有 >=2 条有效收益率。");
        }

        const grouped = Object.fromEntries(
          validIds.map((id) => [id, grouped0[id]])
        );
        const weights = parseWeights(validIds);
        ids = validIds;

        const sigLatest = Object.fromEntries(
          ids.map((id) => {
            const r = grouped[id].map((x) => x.logRet).filter(Number.isFinite);
            return [id, latestSigmaRolling(r, window)];
          })
        );

        let wideRaw = alignedWideReturns(grouped);
        let wideClean = wideRaw.filter((row) =>
          ids.every((id) => Number.isFinite(row[id]))
        );
        if (wideClean.length < 2) {
          throw new Error(
            "组合对齐后的有效交集日期太少（wideClean<2）。请换一组交易日期重叠更多的品种，或缩小品种范围。"
          );
        }

        const sigTxt = ids
          .map((id) => `${id}:${sigLatest[id].toFixed(6)}`)
          .join("; ");
        const wTxt = ids
          .map((id) => `${id}=${weights[id].toFixed(3)}`)
          .join(", ");

        lines.push("[多品种组合]");
        lines.push("参与品种： " + ids.join(", "));
        lines.push("权重（归一化后）： " + wTxt);
        lines.push("最新 σ_i： " + sigTxt + "\n");

        lines.push("— 正态参数 组合 VaR（收益率口径）—");
        for (const c of confs) {
          const z = zFromConf(c);
          const vList = Ts.map(
            (T) => normalVarPortfolio(grouped, c, T, window, weights).var
          );
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
            extra: `z=${z.toFixed(3)} | w=[${wTxt}] | σ_latest=[${sigTxt}]`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }

        const wVec = ids.map((id) => weights[id]);
        const rpHist = wideClean
          .map((r) =>
            ids.reduce((s, id, i) => s + r[id] * wVec[i], 0)
          )
          .filter(Number.isFinite);

        lines.push("\n— 蒙特卡洛 组合 VaR（历史组合收益 i.i.d.）—");
        for (const c of confs) {
          const vList = [];
          for (const T of Ts) {
            setProgressText(`组合 MC：c=${c.toFixed(3)} T=${T} …`);
            const out = await callWorkerSingle(rpHist, c, T);
            vList.push(out.var);
          }
          lines.push(
            `  c=${c.toFixed(3)} | ` +
              Ts.map(
                (T, i) =>
                  `T=${T}: ${vList[i].toFixed(6)} (${(vList[i] * 100).toFixed(
                    3
                  )}%)`
              ).join(" | ")
          );
          rows.push({
            method: `MC ${mcMethod}（组合）`,
            conf: c.toFixed(3),
            extra: `w=[${wTxt}] | K=${sims}`,
            v1: fmtPct2(vList[0]),
            v2: fmtPct2(vList[1]),
            v3: fmtPct2(vList[2]),
          });
        }

        const widePrice = alignedWidePrices(grouped).map((row) => ({
          ...row,
          date: row.date.toISOString().slice(0, 10),
        }));
        setPriceSeriesIds(ids);
        setPriceSeries(widePrice);
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

  const exportResults = () => {
    const ws = XLSX.utils.json_to_sheet(resultRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "VaR");
    XLSX.writeFile(wb, "VaR_results.xlsx");
  };

  return (
    <div className="h-full w-full bg-gradient-to-br from-slate-50 via-white to-slate-100 text-slate-900">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 bg-white/70 backdrop-blur border-b border-slate-200">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-lg font-bold tracking-tight">
            期货 VaR 计算器（Web）
          </div>
          <div className="text-xs text-slate-500">
            Normal / t-auto / Bootstrap · 单品种 / 组合
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm cursor-pointer hover:opacity-90 active:scale-95 transition">
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
              className="px-3 py-1.5 rounded-lg bg-white border shadow-sm text-sm hover:bg-slate-50 active:scale-95 transition"
            >
              加载测试数据
            </button>

            {resultRows.length > 0 && (
              <button
                onClick={exportResults}
                className="px-3 py-1.5 rounded-lg bg-white border shadow-sm text-sm hover:bg-slate-50 active:scale-95 transition"
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
          {/* 左侧参数区 */}
          <div className="col-span-12 lg:col-span-4 xl:col-span-3 space-y-3 pr-1">
            <Card title="1. 数据输入">
              <div className="text-sm text-slate-600">
                {fileName || "未选择文件"}
              </div>
            </Card>

            <Card title="2. 列映射（自动识别，可手动修改）">
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
            </Card>

            <Card title="3.1 共用参数">
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
              </div>
            </Card>

            <Card title="3.2 正态分布特有参数">
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
            </Card>

            <Card title="3.3 Monte Carlo 特有参数">
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
                    <option value="t_auto">t-MC（厚尾，ν自动拟合）</option>
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
                      t df 搜索上限 <Help tip={HELP_TEXT.dfMax} />
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
            </Card>

            <Card
              title={
                <span className="inline-flex items-center">
                  4. 计算模式 <Help tip={HELP_TEXT.mode} />
                </span>
              }
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
                  <Field
                    label={
                      <span className="inline-flex items-center">
                        单品种选择 <Help tip={HELP_TEXT.singleId} />
                      </span>
                    }
                  >
                    <select
                      className="w-full border rounded-lg px-2 py-1"
                      value={singleId}
                      onChange={(e) => setSingleId(e.target.value)}
                    >
                      {idsAll.map((id) => (
                        <option key={id}>{id}</option>
                      ))}
                    </select>
                  </Field>
                )}

                {mode === "portfolio" && (
                  <>
                    <div className="text-sm text-slate-600 inline-flex items-center">
                      勾选参与组合品种：
                      <Help tip={HELP_TEXT.portfolioIds} />
                    </div>

                    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto border rounded-lg p-2 bg-white">
                      {idsAll.map((id) => {
                        const checked = portfolioIds.includes(id);
                        return (
                          <label
                            key={id}
                            className="flex items-center gap-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setPortfolioIds((prev) =>
                                  checked
                                    ? prev.filter((x) => x !== id)
                                    : [...prev, id]
                                );
                              }}
                            />
                            {id}
                          </label>
                        );
                      })}
                    </div>

                    <Field
                      label={
                        <span className="inline-flex items-center">
                          组合权重（可选） <Help tip={HELP_TEXT.weightsText} />
                        </span>
                      }
                    >
                      <input
                        type="text"
                        placeholder="CFI=0.7,RBFI=0.3"
                        className="w-full border rounded-lg px-2 py-1"
                        value={weightsText}
                        onChange={(e) => setWeightsText(e.target.value)}
                      />
                    </Field>
                  </>
                )}
              </div>
            </Card>

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

          {/* 右侧结果区 */}
          <div className="col-span-12 lg:col-span-8 xl:col-span-9 flex flex-col gap-4">
            <Card title="结果输出（文本摘要）">
              <AnimatePresence mode="wait">
                {loading ? (
                  <motion.div
                    key="loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="h-full flex items-center justify-center text-slate-600"
                  >
                    <div className="flex flex-col items-center gap-3">
                      <div className="h-10 w-10 rounded-full border-4 border-slate-300 border-t-slate-900 animate-spin" />
                      <div className="text-sm">
                        {progressText || "Monte Carlo 计算中，请稍候…"}
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.pre
                    key="summary"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-sm whitespace-pre-wrap font-mono text-slate-800"
                  >
                    {summary || "请先读取文件并设置参数。"}
                  </motion.pre>
                )}
              </AnimatePresence>
            </Card>

            <Card title="结果输出（表格视图）">
              <table className="w-full text-sm">
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
                      <td className="max-w-[260px] truncate" title={r.extra}>
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
              <div className="text-xs text-slate-500 mt-2">
                表格仅展示 VaR 百分比（保留两位小数）。
              </div>
            </Card>

            <Card title="行情走势图（价格）">
              <div className="h-[360px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={priceSeries}>
                    <XAxis dataKey="date" hide />
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
                        name={id}
                        stroke={PALETTE[idx % PALETTE.length]}
                        strokeWidth={2}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="text-xs text-slate-500 mt-2">
                单品种显示单线；多品种按品种分线展示价格走势（0 值/缺失已前向填充）。
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
