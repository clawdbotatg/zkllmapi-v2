#!/bin/bash
# update.sh — Pull latest code and redeploy the ZK API Credits v2 backend
# Run this on the AWS box: bash ~/zkllmapi-v2/update.sh

set -e

CONTAINER_NAME="zk-v2-backend"
IMAGE_NAME="zk-v2-backend"
ENV_FILE="packages/backend/.env"
BACKEND_URL="https://backend.v2.zkllmapi.com"
ALCHEMY_KEY="AlQf7KFYpAw_AlE4oCP85"

cd ~/zkllmapi-v2

echo "🔄 Pulling latest code..."
git pull

echo ""
echo "🔍 Patching RPC/WS URLs (Alchemy)..."
for VAR_VALUE in \
  "RPC_URL=https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY" \
  "WS_URL=wss://base-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY"; do
  VAR="${VAR_VALUE%%=*}"
  if grep -q "^$VAR=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^$VAR=.*|$VAR_VALUE|" "$ENV_FILE"
  else
    echo "$VAR_VALUE" >> "$ENV_FILE"
  fi
done
echo "   ✅ RPC/WS updated"

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

docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -p 3002:3002 \
  --restart unless-stopped \
  "$IMAGE_NAME"

echo ""
echo "⏳ Waiting for server to start..."
sleep 10

echo "✅ Health check:"
HEALTH=$(curl -s "$BACKEND_URL/health")
echo "$HEALTH" | python3 -m json.tool

TREE_SIZE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('treeSize',0))")
if [ "$TREE_SIZE" = "0" ]; then
  echo ""
  echo "⚠️  WARNING: treeSize is 0 — backend may have wrong CONTRACT_ADDRESS or RPC issue"
fi

echo ""
echo "✅ Circuit check:"
curl -s "$BACKEND_URL/circuit" | head -c 100
echo ""

echo ""
echo "🧹 Cleaning up old images..."
docker image prune -f

echo ""
echo "🎉 Done!"
