#!/usr/bin/env bash
echo "📜 Streaming Tocsin logs (Press Ctrl+C to exit)..."
docker compose logs -f "$@"
