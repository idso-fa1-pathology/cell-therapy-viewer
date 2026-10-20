FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.13-slim-bookworm
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VIEWER_HOST=0.0.0.0 \
    VIEWER_PORT=8000 \
    DATA_DIR=/data \
    CACHE_DIR=/cache
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -c "import openslide; print(openslide.__library_version__)" \
    && mkdir /data /cache
COPY server.py prepare.py THIRD_PARTY_NOTICES.txt ./
COPY --from=frontend /build/dist ./dist
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8000/api/health', timeout=2)"
CMD ["python", "server.py"]
