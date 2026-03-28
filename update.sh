#!/bin/bash
# update.sh — Pull latest code and redeploy the ZK API Credits v2 backend
# Run this on the AWS box: bash ~/zkllmapi-v2/update.sh

set -e

CONTAINER_NAME="zk-v2-backend"
IMAGE_NAME="zk-v2-backend"
ENV_FILE="packages/backend/.env"
BACKEND_URL="https://backend.v2.zkllmapi.com"

cd ~/zkllmapi-v2

echo "🔄 Pulling latest code..."
git pull

echo ""
echo "🔍 Syncing contract address from externalContracts.ts..."
CONTRACT=$(grep -oP 'address:\s*"(0x[0-9a-fA-F]+)"' packages/nextjs/contracts/externalContracts.ts | head -1 | grep -oP '0x[0-9a-fA-F]+')
if [ -n "$CONTRACT" ]; then
  echo "   Contract: $CONTRACT"
  if grep -q "^CONTRACT_ADDRESS=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s/^CONTRACT_ADDRESS=.*/CONTRACT_ADDRESS=$CONTRACT/" "$ENV_FILE"
  else
    echo "CONTRACT_ADDRESS=$CONTRACT" >> "$ENV_FILE"
  fi
  echo "   ✅ .env updated"
else
  echo "   ⚠️  Could not extract contract address, keeping existing .env value"
fi

echo ""
echo "🐳 Rebuilding Docker image..."
docker build -f packages/backend/Dockerfile -t "$IMAGE_NAME" .

echo ""
echo "🔁 Replacing container..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# .env sets PORT=3002; map host 3002 → container 3002
docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -p 3002:3002 \
  --restart unless-stopped \
  "$IMAGE_NAME"

echo ""
echo "⏳ Waiting for server to start..."
sleep 8

echo "✅ Health check:"
curl -s "$BACKEND_URL/health" | python3 -m json.tool

echo ""
echo "✅ Circuit check:"
curl -s "$BACKEND_URL/circuit" | head -c 100
echo ""

echo ""
echo "🧹 Cleaning up old images..."
docker image prune -f

echo ""
echo "🎉 Done!"
