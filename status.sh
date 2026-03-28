#!/bin/bash
# status.sh — Check deploy status of ZK API Credits v2 backend
# Run this on the AWS box: bash ~/zkllmapi-v2/status.sh

set -e

CONTAINER_NAME="zk-v2-backend"
BACKEND_URL="https://backend.v2.zkllmapi.com"

cd ~/zkllmapi-v2

echo "📦 Current local commit:"
git log -1 --oneline

echo ""
echo "🌐 Remote commits (unpulled):"
git fetch origin main -q
git log HEAD..origin/main --oneline || echo "   (up to date)"

echo ""
echo "🐳 Running containers:"
docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "✅ Health check:"
curl -s "$BACKEND_URL/health" | python3 -m json.tool

echo ""
echo "💾 Disk usage:"
df -h / | tail -1

echo ""
echo "📋 Last 20 server logs:"
docker logs "$CONTAINER_NAME" --tail 20
