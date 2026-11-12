# Speech-to-text sidecar: faster-whisper on CPU. See server.py.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Models are downloaded on first use and kept on a volume.
    HF_HOME=/models

# faster-whisper 1.1.1 imports `requests` without declaring it (newer
# huggingface_hub no longer pulls it in) and passes `metadata_errors` to
# av.open(), which PyAV 14 removed — so both are pinned here.
RUN pip install faster-whisper==1.1.1 "av>=11,<14" requests

WORKDIR /app
COPY server.py .

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9000/health').status==200 else 1)"

CMD ["python", "server.py"]
