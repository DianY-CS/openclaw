FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY requirements.txt /tmp/openclaw-research-requirements.txt
RUN pip install --no-cache-dir -r /tmp/openclaw-research-requirements.txt

CMD ["python", "-m", "uvicorn", "jobs.runner.app:app", "--host", "127.0.0.1", "--port", "8787"]
