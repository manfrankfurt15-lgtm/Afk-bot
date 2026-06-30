#!/bin/bash
set -e

echo ""
echo "🚀 Oracle Cloud Setup - Minecraft AFK Bot"
echo "==========================================="
echo ""

# GitHub Token abfragen falls nicht gesetzt
if [ -z "$GITHUB_TOKEN" ]; then
  echo "⚠️  Gib deinen GitHub Personal Access Token ein"
  echo "   (Du findest ihn bei GitHub → Settings → Developer Settings → Tokens)"
  echo ""
  read -s -p "GitHub Token: " GITHUB_TOKEN
  echo ""
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ Kein GitHub Token angegeben. Abbruch."
  exit 1
fi

echo ""
echo "📦 Schritt 1/5: Node.js 20 installieren..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
sudo apt-get install -y nodejs > /dev/null 2>&1
echo "   ✅ Node.js $(node -v) installiert"

echo ""
echo "📦 Schritt 2/5: PM2 installieren (hält Bot am Laufen)..."
sudo npm install -g pm2 > /dev/null 2>&1
echo "   ✅ PM2 installiert"

echo ""
echo "📥 Schritt 3/5: Bot-Code von GitHub laden..."
BOT_DIR="$HOME/Afk-bot"
if [ -d "$BOT_DIR/.git" ]; then
  echo "   🔄 Update existierender Installation..."
  cd "$BOT_DIR"
  git remote set-url origin "https://$GITHUB_TOKEN@github.com/manfrankfurt15-lgtm/Afk-bot.git"
  git pull -q
else
  rm -rf "$BOT_DIR"
  git clone -q "https://$GITHUB_TOKEN@github.com/manfrankfurt15-lgtm/Afk-bot.git" "$BOT_DIR"
  cd "$BOT_DIR"
fi
echo "   ✅ Bot-Code geladen"

echo ""
echo "📦 Schritt 4/5: npm Pakete installieren..."
npm install --silent
echo "   ✅ Pakete installiert"

echo ""
echo "⚙️  Schritt 5/5: PM2 konfigurieren und starten..."

# PM2 Ecosystem config erstellen
cat > "$BOT_DIR/ecosystem.config.cjs" << EOF
module.exports = {
  apps: [
    {
      name: 'afk-account1',
      script: 'single-bot.mjs',
      node_args: '--max-old-space-size=400',
      env: {
        GITHUB_TOKEN: '$GITHUB_TOKEN',
        ACCOUNT_ID:   'account1',
        BOT_ACCOUNT:  'account1',
        BOT_USERNAME: 'Bot1',
        PORT:         '3001'
      },
      restart_delay: 10000,
      max_restarts: 50,
      autorestart: true
    },
    {
      name: 'afk-account2',
      script: 'single-bot.mjs',
      node_args: '--max-old-space-size=400',
      env: {
        GITHUB_TOKEN: '$GITHUB_TOKEN',
        ACCOUNT_ID:   'account2',
        BOT_ACCOUNT:  'account2',
        BOT_USERNAME: 'Bot2',
        PORT:         '3002'
      },
      restart_delay: 10000,
      max_restarts: 50,
      autorestart: true
    },
    {
      name: 'afk-account3',
      script: 'single-bot.mjs',
      node_args: '--max-old-space-size=400',
      env: {
        GITHUB_TOKEN: '$GITHUB_TOKEN',
        ACCOUNT_ID:   'account3',
        BOT_ACCOUNT:  'account3',
        BOT_USERNAME: 'Bot3',
        PORT:         '3003'
      },
      restart_delay: 10000,
      max_restarts: 50,
      autorestart: true
    }
  ]
}
EOF

# Laufende PM2 Prozesse stoppen (falls vorhanden)
pm2 delete all > /dev/null 2>&1 || true

# Bots starten
cd "$BOT_DIR"
pm2 start ecosystem.config.cjs

# PM2 beim Neustart automatisch starten
pm2 save > /dev/null 2>&1
STARTUP_CMD=$(pm2 startup systemd -u $USER --hp $HOME 2>/dev/null | grep "sudo env")
if [ -n "$STARTUP_CMD" ]; then
  eval "sudo $STARTUP_CMD" > /dev/null 2>&1 || true
fi

echo ""
echo "=================================================="
echo "✅ SETUP ABGESCHLOSSEN!"
echo "=================================================="
echo ""
echo "📊 Status anzeigen:    pm2 status"
echo "📋 Logs Account 1:     pm2 logs afk-account1"
echo "📋 Logs Account 2:     pm2 logs afk-account2"
echo "📋 Logs Account 3:     pm2 logs afk-account3"
echo "🔄 Neu starten:        pm2 restart all"
echo "⛔ Stoppen:            pm2 stop all"
echo "🔄 Bot updaten:        cd ~/Afk-bot && git pull && pm2 restart all"
echo ""
echo "Die Bots starten jetzt automatisch bei jedem Server-Neustart!"
echo ""

pm2 status
