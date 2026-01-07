from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Body
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from var_engine import mc_single


BASE_DIR = Path(__file__).resolve().parent
DIST_DIR = BASE_DIR / "static"  # 将前端 build 后的 dist 复制到这里
DATA_DIR = BASE_DIR / "data"

app = FastAPI(title="万能VaR计算器 Backend")


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/api/testdata")
def get_testdata():
    p = DATA_DIR / "testData.json"
    if not p.exists():
        return JSONResponse(status_code=404, content={"ok": False, "error": "testData.json not found"})
    return FileResponse(p, media_type="application/json")


@app.post("/api/mcSingle")
def api_mc_single(payload: Dict[str, Any] = Body(...)):
    try:
        r = payload.get("r", [])
        conf = float(payload.get("conf"))
        T = int(payload.get("T"))
        sims = int(payload.get("sims"))
        method = str(payload.get("method"))
        df_max = int(payload.get("dfMax", 60))
        return mc_single(r=r, conf=conf, T=T, sims=sims, method=method, df_max=df_max)
    except Exception as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})


# ---------- 静态文件 ----------
# 注意：部署时需要把前端 dist 拷贝到 backend/static
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
