#!/usr/bin/env bash
set -euo pipefail

# --- Run on Azure GPU VM (Ubuntu 22.04, NC-series) ---
# Usage: scp -r server/ user@vm:~/curb/ && ssh user@vm 'bash ~/curb/deploy/vm-deploy.sh'

APP_DIR="$HOME/curb"
DOMAIN="${CURB_DOMAIN:-}"  # Set env var for Let's Encrypt, or leave empty for self-signed

echo "=== Curb VM Deployment ==="

# 1. System packages
echo "--- Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq python3.11 python3.11-venv python3.11-dev nginx certbot python3-certbot-nginx curl

# 2. Verify GPU
echo "--- Checking GPU..."
if command -v nvidia-smi &>/dev/null; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
    echo "WARNING: nvidia-smi not found. YOLO will run on CPU (slow)."
fi

# 3. Python venv
echo "--- Setting up Python venv..."
cd "$APP_DIR"
python3.11 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip -q
pip install -r requirements.txt -q

# Install CUDA PyTorch if GPU is available
if command -v nvidia-smi &>/dev/null; then
    echo "--- Installing PyTorch with CUDA..."
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121 -q
fi

# 4. Download YOLOv8m weights if not present
if [ ! -f "yolov8m.pt" ]; then
    echo "--- Downloading yolov8m.pt..."
    python -c "from ultralytics import YOLO; YOLO('yolov8m.pt')"
fi

# 5. SSL Certificate
echo "--- Setting up SSL..."
CERT_DIR="/etc/letsencrypt/live/curb"
sudo mkdir -p "$CERT_DIR"

if [ -n "$DOMAIN" ]; then
    echo "--- Requesting Let's Encrypt cert for $DOMAIN..."
    sudo certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@${DOMAIN}" \
        --cert-name curb || {
        echo "Let's Encrypt failed, falling back to self-signed..."
        DOMAIN=""
    }
fi

if [ -z "$DOMAIN" ]; then
    echo "--- Generating self-signed certificate..."
    sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$CERT_DIR/privkey.pem" \
        -out "$CERT_DIR/fullchain.pem" \
        -subj "/CN=curb-server"
fi

# 6. Nginx config
echo "--- Configuring nginx..."
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/curb
sudo ln -sf /etc/nginx/sites-available/curb /etc/nginx/sites-enabled/curb
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx

# 7. Systemd service
echo "--- Creating systemd service..."
sudo tee /etc/systemd/system/curb.service > /dev/null <<EOF
[Unit]
Description=Curb API Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
Environment=PATH=$APP_DIR/.venv/bin:/usr/bin
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable curb
sudo systemctl restart curb

echo ""
echo "=== Deployment complete! ==="
echo "Service status:"
sudo systemctl status curb --no-pager -l
echo ""
if [ -n "$DOMAIN" ]; then
    echo "Open: https://$DOMAIN/"
else
    echo "Open: https://$(curl -s ifconfig.me)/"
fi
echo "Dashboard: /dashboard"
