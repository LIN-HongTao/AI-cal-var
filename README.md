# VaR 计算器（前端 HTML + 后端 Python）

## 目录结构
- `frontend/`：前端（Vite + React + Tailwind，最终会 build 成 `dist/` 静态 HTML/JS/CSS）
- `backend/`：后端（FastAPI），负责：
  - 提供内置数据 `data/testData.json`
  - 负责原 `varWorker.js` 的 Monte Carlo 计算接口 `/api/mcSingle`
  - 静态托管前端 build 输出（把 `frontend/dist` 复制到 `backend/static`）

## 本地启动（推荐）
### 1) 启动后端
```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

### 2) 构建前端并交给后端托管
```bash
cd frontend
npm i
npm run build
# 把 dist 复制到 backend/static
rm -rf ../backend/static
cp -r dist ../backend/static
```

然后访问：
- http://127.0.0.1:8000

## 开发模式
- 后端：`uvicorn app:app --reload --port 8000`
- 前端：`npm run dev`（已配置 `/api` 代理到 `http://127.0.0.1:8000`）

## Docker 容器化运行
> 直接使用仓库根目录的 `Dockerfile`，会打包后端（含 `backend/static` 静态前端）并启动 FastAPI。

### 构建镜像
```bash
docker build -t var-calculator:latest .
```

### 运行容器
```bash
docker run --rm -p 8000:8000 var-calculator:latest
```

访问：
- http://127.0.0.1:8000
