#!/usr/bin/env bash

# Imou Recording Service Installer Script
# Designed for Debian/Ubuntu Linux

set -euo pipefail

# Ensure the script is run with root privileges for systemd setup
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (using sudo):"
  echo "sudo ./setup.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
echo "=== Starting Setup for Imou MQTT Video Recorder in $APP_DIR ==="

# 1. Check/Install Node.js and NPM
NODE_VERSION="v24.16.0"
echo "Checking Node.js installation..."
if ! command -v node &> /dev/null; then
  echo "Node.js is not installed. Installing Node.js $NODE_VERSION dynamically..."
  
  # Detect hardware architecture
  ARCH="x64"
  if [ "$(uname -m)" = "aarch64" ]; then
    ARCH="arm64"
  elif [ "$(uname -m)" = "armv7l" ]; then
    ARCH="armv7l"
  fi
  
  TAR_NAME="node-$NODE_VERSION-linux-$ARCH.tar.xz"
  DOWNLOAD_URL="https://nodejs.org/dist/$NODE_VERSION/$TAR_NAME"
  
  echo "Downloading Node.js binary tarball from $DOWNLOAD_URL..."
  if ! curl -fsSL "$DOWNLOAD_URL" -o "/tmp/$TAR_NAME"; then
    echo "Error: Failed to download Node.js tarball. Please verify network connection."
    exit 1
  fi
  
  echo "Extracting Node.js binaries to /usr/local..."
  tar -xJf "/tmp/$TAR_NAME" -C /usr/local --strip-components=1
  rm -f "/tmp/$TAR_NAME"
  
  echo "Node.js installation completed."
fi
echo "Node.js version: $(node -v)"
echo "NPM version:    $(npm -v)"

# Install Puppeteer/Chrome system-level dependencies (Debian/Ubuntu)
if command -v apt-get &> /dev/null; then
  echo "Debian/Ubuntu detected. Installing system dependencies for headless Chrome..."
  apt-get update
  apt-get install -y \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    lsb-release \
    xdg-utils \
    libxshmfence1
else
  echo "Non-Debian/Ubuntu system. Please ensure standard headless Chromium libraries are installed manually."
fi

# 2. Install Dependencies
echo "Installing Node.js dependencies..."
cd "$APP_DIR"
npm install --omit=dev

echo "Installing Puppeteer Chrome browser binary..."
npx puppeteer browsers install chrome

# 3. Handle Environment Variables Setup
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "No .env file found. Creating one..."
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  
  echo "--------------------------------------------------------"
  echo "Please enter your configuration values (or press Enter to keep defaults/placeholders):"
  
  read -p "Imou App ID [lca50e6837ccd64597]: " IMOU_ID
  IMOU_ID=${IMOU_ID:-"lca50e6837ccd64597"}
  sed -i "s/IMOU_APP_ID=.*/IMOU_APP_ID=$IMOU_ID/" "$ENV_FILE"
  
  read -p "Imou App Secret [91c0adeb82ac482aafbfe9fd79021e]: " IMOU_SECRET
  IMOU_SECRET=${IMOU_SECRET:-"91c0adeb82ac482aafbfe9fd79021e"}
  sed -i "s/IMOU_APP_SECRET=.*/IMOU_APP_SECRET=$IMOU_SECRET/" "$ENV_FILE"

  read -p "Imou Data Center (e.g., sg, fk, or) [sg]: " IMOU_DC
  IMOU_DC=${IMOU_DC:-"sg"}
  sed -i "s/IMOU_DATA_CENTER=.*/IMOU_DATA_CENTER=$IMOU_DC/" "$ENV_FILE"

  read -p "Supabase URL: " SUPA_URL
  if [ -n "$SUPA_URL" ]; then
    sed -i "s|SUPABASE_URL=.*|SUPABASE_URL=$SUPA_URL|" "$ENV_FILE"
  fi

  read -p "Supabase Key: " SUPA_KEY
  if [ -n "$SUPA_KEY" ]; then
    sed -i "s/SUPABASE_KEY=.*/SUPABASE_KEY=$SUPA_KEY/" "$ENV_FILE"
  fi

  read -p "Cloudflare R2 Account ID: " R2_ACC
  if [ -n "$R2_ACC" ]; then
    sed -i "s/R2_ACCOUNT_ID=.*/R2_ACCOUNT_ID=$R2_ACC/" "$ENV_FILE"
  fi

  read -p "Cloudflare R2 Access Key ID: " R2_KEY
  if [ -n "$R2_KEY" ]; then
    sed -i "s/R2_ACCESS_KEY_ID=.*/R2_ACCESS_KEY_ID=$R2_KEY/" "$ENV_FILE"
  fi

  read -p "Cloudflare R2 Secret Access Key: " R2_SEC
  if [ -n "$R2_SEC" ]; then
    sed -i "s/R2_SECRET_ACCESS_KEY=.*/R2_SECRET_ACCESS_KEY=$R2_SEC/" "$ENV_FILE"
  fi

  read -p "Cloudflare R2 Bucket Name: " R2_BUCKET
  if [ -n "$R2_BUCKET" ]; then
    sed -i "s/R2_BUCKET_NAME=.*/R2_BUCKET_NAME=$R2_BUCKET/" "$ENV_FILE"
  fi

  read -p "R2 Public Custom Domain URL: " R2_DOM
  if [ -n "$R2_DOM" ]; then
    sed -i "s|R2_PUBLIC_URL_CUSTOM_DOMAIN=.*|R2_PUBLIC_URL_CUSTOM_DOMAIN=$R2_DOM|" "$ENV_FILE"
  fi

  read -p "MQTT Broker URL [mqtt://broker.emqx.io:1883]: " MQTT_URL
  MQTT_URL=${MQTT_URL:-"mqtt://broker.emqx.io:1883"}
  sed -i "s|MQTT_BROKER_URL=.*|MQTT_BROKER_URL=$MQTT_URL|" "$ENV_FILE"

  read -p "MQTT Topic [cmaphcm/cam-cut]: " MQTT_TOP
  MQTT_TOP=${MQTT_TOP:-"cmaphcm/cam-cut"}
  sed -i "s|MQTT_TOPIC=.*|MQTT_TOPIC=$MQTT_TOP|" "$ENV_FILE"

  echo ".env configuration file created successfully."
else
  echo ".env configuration file already exists. Skipping prompts."
fi

# 4. Configure systemd Service file
echo "Configuring systemd service..."
SERVICE_FILE="/etc/systemd/system/imou-recorder.service"

# Generate systemd file referencing the current working directory dynamically
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=Imou Camera Video Playback Recording and MQTT Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "Systemd service file created at $SERVICE_FILE."

# 5. Start and Enable Service
echo "Enabling and starting service via systemctl..."
systemctl daemon-reload
systemctl enable imou-recorder.service
systemctl restart imou-recorder.service

echo "=== Setup Completed Successfully! ==="
echo "Checking service status..."
systemctl status imou-recorder.service --no-pager
echo "To view live logs, run: journalctl -u imou-recorder.service -f"
