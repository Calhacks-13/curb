FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system curb \
    && useradd --system --gid curb --create-home curb

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install --requirement requirements.txt

COPY app ./app
COPY scripts ./scripts

RUN chown -R curb:curb /app

USER curb

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import json, urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4))['status'] in {'ok', 'healthy'}"

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
