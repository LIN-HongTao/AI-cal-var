# syntax=docker/dockerfile:1

# Pin to Debian stable (avoid trixie/testing repo signature issues)
FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install Python deps (cache-friendly)
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy backend (includes static/ built frontend and data/testData.json)
COPY backend /app/backend

WORKDIR /app/backend

EXPOSE 8000

# Optional container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; \
  url='http://127.0.0.1:8000/api/health'; \
  sys.exit(0) if urllib.request.urlopen(url, timeout=3).status==200 else sys.exit(1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
