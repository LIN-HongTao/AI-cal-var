import React, { useMemo, useRef, useState } from "react";
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
} from "recharts";
import clsx from "clsx";

import VarWorker from "./workers/varWorker?worker";
import testData from "./data/testData.json";


// ==================== 计算函数（对齐你原 Py 逻辑） ====================
function zFromConf(conf) {
  if (Math.abs(conf - 0.95) < 1e-6) return 1.645;
  if (Math.abs(conf - 0.99) < 1e-6) return 2.33;
  // Moro approximation
  const a = [
    2.50662823884,
    -18.61500062529,
    41.39119773534,
    -25.44106049637,
  ];
  const b = [
    -8.4735109309,
    23.08336743743,
    -21.06224101826,
    3.13082909833,
  ];
  const c = [
    0.3374754822726147,
    0.9761690190917186,
    0.1607979714918209,
    0.0276438810333863,
    0.0038405729373609,
    0.0003951896511919,
    0.0000321767881768,
    0.0000002888167364,
    0.0000003960315187,
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

/**
 * 对齐为 wide format：每行一个 date，每列一个 id 的 logRet
 * 注意：这里只做交集日期；过滤 NaN 在外层处理
 */
function alignedWideReturns(grouped) {
  const ids = Object.keys(grouped);

  // 用 timestamp（number）作为 key
  const mapById = {};
  ids.forEach((id) => {
    const m = new Map();
    grouped[id].forEach((r) => {
      const key = +r.date; // 等价 r.date.getTime()
      m.set(key, r.logRet);
    });
    mapById[id] = m;
  });

  // 取交集日期（这里的 key 是 number）
  const dateKeys = ids.reduce((acc, id) => {
    const s = new Set(mapById[id].keys());
    if (acc == null) return s;
    return new Set([...acc].filter((k) => s.has(k)));
  }, null);

  const alignedKeys = [...dateKeys].sort((a, b) => a - b);

  return alignedKeys.map((k) => {
    const row = { date: new Date(k) }; // 还原 Date 仅用于展示
    ids.forEach((id) => (row[id] = mapById[id].get(k)));
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

/**
 * 组合正态参数 VaR
 * 修复：wide 行级过滤 NaN；corr 才能正常
 */
function normalVarPortfolio(grouped, conf, T, window, weights) {
  const ids = Object.keys(grouped);
  const m = ids.length;
  const w = ids.map((id) => weights?.[id] ?? 1 / m);

  const sigmas = ids.map((id) => {
    const arr = grouped[id].map((x) => x.logRet);
    return latestSigmaRolling(arr, window);
  });

  let wide = alignedWideReturns(grouped);

  // ✅ 关键修复：过滤掉任何品种非有限的行（含第一行 NaN）
  wide = wide.filter((row) =>
    ids.every((id) => Number.isFinite(row[id]))
  );

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
    {title && (
      <div className="font-semibold text-slate-800 mb-3">{title}</div>
    )}
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

  const [mcMethod, setMcMethod] = useState("normal"); // normal | t_auto | bootstrap
  const [sims, setSims] = useState(200000);
  const [dfMax, setDfMax] = useState(60);
  const [seed, setSeed] = useState("");

  const [mode, setMode] = useState("single"); // single | portfolio
  const [singleId, setSingleId] = useState("");
  const [portfolioIds, setPortfolioIds] = useState([]);
  const [weightsText, setWeightsText] = useState("");

  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [resultRows, setResultRows] = useState([]);
  const [summary, setSummary] = useState("");
  const [retSeries, setRetSeries] = useState([]);

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

    // 自动识别列
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

  // ============ 数据预处理（读表+log收益） ============
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

  // ============ 加载测试数据 ============
  const loadTestData = () => {
    setFileName("内置测试数据 testData.json");
    setRawRows(testData);

    const cols = testData.length ? Object.keys(testData[0]) : [];
    setColumns(cols);

    // 自动识别列（沿用你原逻辑）
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


    // 去重同 id+date 取最后一条
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

    // log returns
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

  // ============ 权重解析 ============
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

  // ============ 计算入口 ============
  const runCalc = async () => {
    if (!idsAll.length) return;

    if (seed.trim()) {
      console.log("seed ignored in pure-js version:", seed);
    }

    setLoading(true);
    setProgressText("预处理中…");
    setResultRows([]);
    setSummary("");

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
        const r = sub.map((x) => x.logRet).filter(Number.isFinite);

        const sigmaLatest = latestSigmaRolling(r, window);
        lines.push(`[单品种] ${cid}`);
        lines.push(`最新 σ(窗口规则) = ${sigmaLatest.toFixed(6)}\n`);

        // 正态参数
        lines.push("— 正态参数 VaR（收益率口径）—");
        for (const c of confs) {
          const z = zFromConf(c);
          const vList = Ts.map((T) => normalVarSingle(r, c, T, window).var);
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
            v1: `${vList[0].toFixed(6)} (${(vList[0] * 100).toFixed(3)}%)`,
            v2: `${vList[1].toFixed(6)} (${(vList[1] * 100).toFixed(3)}%)`,
            v3: `${vList[2].toFixed(6)} (${(vList[2] * 100).toFixed(3)}%)`,
          });
        }
        lines.push("");

        // MC
        lines.push(`— 蒙特卡洛 VaR（${mcMethod}）—`);
        for (const c of confs) {
          const vList = [];
          for (const T of Ts) {
            setProgressText(`MC 计算中：c=${c.toFixed(3)} T=${T} …`);
            const out = await callWorkerSingle(r, c, T);
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
            v1: `${vList[0].toFixed(6)} (${(vList[0] * 100).toFixed(3)}%)`,
            v2: `${vList[1].toFixed(6)} (${(vList[1] * 100).toFixed(3)}%)`,
            v3: `${vList[2].toFixed(6)} (${(vList[2] * 100).toFixed(3)}%)`,
          });
        }

        setRetSeries(
          sub
            .map((x) => ({
              date: x.date.toISOString().slice(0, 10),
              logRet: x.logRet,
            }))
            .filter((x) => Number.isFinite(x.logRet))
        );
      } else {
        // ==================== portfolio 模式（修复版） ====================
        let ids = portfolioIds;
        if (ids.length < 2) throw new Error("组合品种不足（至少选 2 个）");

        // 初步 grouped/weights
        const grouped0 = Object.fromEntries(ids.map((id) => [id, groupedAll[id]]));
        const weights0 = parseWeights(ids);

        // ✅ 先剔除样本不足的品种
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

        const sigLatest = Object.fromEntries(
          ids.map((id) => {
            const r = grouped[id].map((x) => x.logRet).filter(Number.isFinite);
            return [id, latestSigmaRolling(r, window)];
          })
        );

        // ✅ 自检 log（你要的那段）
        let wideRaw = alignedWideReturns(grouped);
        let wideClean = wideRaw.filter((row) =>
          ids.every((id) => Number.isFinite(row[id]))
        );
        console.log("wide raw:", wideRaw.length);
        console.log("wide clean:", wideClean.length);
        console.log("sigmaLatest:", sigLatest);

        if (wideClean.length < 2) {
          throw new Error(
            "组合对齐后的有效交集日期太少（wideClean<2）。请换一组交易日期重叠更多的品种，或缩小品种范围。"
          );
        }

        const sigTxt = ids
          .map((id) => `${id}:${sigLatest[id].toFixed(6)}`)
          .join("; ");
        const wTxt = ids.map((id) => `${id}=${weights[id].toFixed(3)}`).join(", ");

        lines.push("[多品种组合]");
        lines.push("参与品种： " + ids.join(", "));
        lines.push("权重（归一化后）： " + wTxt);
        lines.push("最新 σ_i： " + sigTxt + "\n");

        // 正态参数组合 VaR
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
            v1: `${vList[0].toFixed(6)} (${(vList[0] * 100).toFixed(3)}%)`,
            v2: `${vList[1].toFixed(6)} (${(vList[1] * 100).toFixed(3)}%)`,
            v3: `${vList[2].toFixed(6)} (${(vList[2] * 100).toFixed(3)}%)`,
          });
        }

        // 组合 MC：用 wideClean -> 组合历史收益
        const wVec = ids.map((id) => weights[id]);
        const rpHist = wideClean
          .map((r) => ids.reduce((s, id, i) => s + r[id] * wVec[i], 0))
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
            v1: `${vList[0].toFixed(6)} (${(vList[0] * 100).toFixed(3)}%)`,
            v2: `${vList[1].toFixed(6)} (${(vList[1] * 100).toFixed(3)}%)`,
            v3: `${vList[2].toFixed(6)} (${(vList[2] * 100).toFixed(3)}%)`,
          });
        }

        setRetSeries(
          wideClean.map((x) => ({
            date: new Date(x.date).toISOString().slice(0, 10),
            logRet: ids.reduce((s, id, i) => s + x[id] * wVec[i], 0),
          }))
        );
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

  // ============ 导出结果 ============
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
            {/* ✅ 新增按钮 */}
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

      {/* 主体 */}
      <div className="max-w-[1600px] mx-auto h-[calc(100%-56px)] px-4 py-4">
        <div className="grid grid-cols-12 gap-4 h-full">
          {/* 左侧参数区 */}
          <div className="col-span-12 lg:col-span-4 xl:col-span-3 space-y-3 overflow-auto pr-1">
            <Card title="1. 数据输入">
              <div className="text-sm text-slate-600">
                {fileName || "未选择文件"}
              </div>
            </Card>

            <Card title="2. 列映射（自动识别，可手动修改）">
              <div className="space-y-2">
                <Field label="品种ID列">
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
                <Field label="日期列">
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
                <Field label="结算价列">
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
                <Field label="置信度 c1">
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
                <Field label="置信度 c2">
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
                <Field label="短期交易日 T1">
                  <input
                    type="number"
                    min="1"
                    className="w-full border rounded-lg px-2 py-1"
                    value={T1}
                    onChange={(e) => setT1(+e.target.value)}
                  />
                </Field>
                <Field label="中期交易日 T2">
                  <input
                    type="number"
                    min="1"
                    className="w-full border rounded-lg px-2 py-1"
                    value={T2}
                    onChange={(e) => setT2(+e.target.value)}
                  />
                </Field>
                <Field label="长期交易日 T3">
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
              <Field label="σ 窗口（交易日）">
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
                <Field label="MC 方法">
                  <select
                    className="w-full border rounded-lg px-2 py-1"
                    value={mcMethod}
                    onChange={(e) => setMcMethod(e.target.value)}
                  >
                    <option value="normal">Normal MC（正态）</option>
                    <option value="t_auto">t-MC（厚尾，ν自动拟合）</option>
                    <option value="bootstrap">
                      Bootstrap MC（历史重采样）
                    </option>
                  </select>
                </Field>
                <Field label="模拟次数 K">
                  <input
                    type="number"
                    min="1000"
                    step="10000"
                    className="w-full border rounded-lg px-2 py-1"
                    value={sims}
                    onChange={(e) => setSims(+e.target.value)}
                  />
                </Field>
                <Field label="t df 搜索上限">
                  <input
                    type="number"
                    min="10"
                    max="300"
                    className="w-full border rounded-lg px-2 py-1"
                    value={dfMax}
                    onChange={(e) => setDfMax(+e.target.value)}
                  />
                </Field>
                <Field label="随机种子（可选）">
                  <input
                    type="text"
                    placeholder="前端版本仅弱复现"
                    className="w-full border rounded-lg px-2 py-1"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                  />
                </Field>
              </div>
            </Card>

            <Card title="4. 计算模式">
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
                  <Field label="单品种选择">
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
                    <div className="text-sm text-slate-600">
                      勾选参与组合品种：
                    </div>
                    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto">
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
                    <Field label="组合权重（可选）">
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
          <div className="col-span-12 lg:col-span-8 xl:col-span-9 flex flex-col gap-4 h-full">
            <Card
              title="结果输出（文本摘要）"
              className="flex-1 min-h-[200px] overflow-auto"
            >
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

            <div className="grid grid-cols-12 gap-4 flex-1 min-h-[240px]">
              <Card
                title="结果输出（表格视图）"
                className="col-span-12 xl:col-span-7 overflow-auto"
              >
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="text-left border-b">
                      <th className="py-2">方法</th>
                      <th>置信度 c</th>
                      <th>附加参数</th>
                      <th>T1 VaR</th>
                      <th>T2 VaR</th>
                      <th>T3 VaR</th>
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
                        <td
                          className="max-w-[260px] truncate"
                          title={r.extra}
                        >
                          {r.extra}
                        </td>
                        <td>{r.v1}</td>
                        <td>{r.v2}</td>
                        <td>{r.v3}</td>
                      </tr>
                    ))}
                    {!resultRows.length && (
                      <tr>
                        <td
                          colSpan={6}
                          className="py-8 text-center text-slate-500"
                        >
                          暂无结果
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>

              <Card
                title="收益率序列（预览）"
                className="col-span-12 xl:col-span-5"
              >
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={retSeries}>
                      <XAxis dataKey="date" hide />
                      <YAxis />
                      <Tooltip />
                      <Line dataKey="logRet" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  显示单品种或组合 log-return 序列。
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
