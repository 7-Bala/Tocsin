FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8001 \
    HOST=0.0.0.0

# Create non-root user and group
RUN groupadd -g 1001 mcpgroup && \
    useradd -u 1001 -g mcpgroup -m -s /bin/bash mcpuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=mcpuser:mcpgroup . .

USER mcpuser

EXPOSE 8001

CMD ["python", "server.py"]
