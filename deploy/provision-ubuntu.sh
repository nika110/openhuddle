#!/bin/bash
# Provision the public OpenHuddle hub on a fresh Ubuntu 24.04 VM. Run as root.
set -euo pipefail

DOMAIN="${1:?usage: provision-hub.sh <domain> [openhuddle-version]}"
VERSION="${2:-latest}"
NODE_MAJOR=24
export PATH="/opt/node/bin:$PATH"

echo "== firewall: open 80 and 443 (Oracle images reject everything but 22)"
for port in 443 80; do
  iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
done
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null
netfilter-persistent save >/dev/null

echo "== swap (1 GB RAM machine)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== node ${NODE_MAJOR} from nodejs.org"
if ! /opt/node/bin/node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  cd /tmp
  NODE_TAR=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep 'linux-x64.tar.xz' | awk '{print $2}')
  curl -fsSLO "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${NODE_TAR}"
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep " ${NODE_TAR}\$" | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "${NODE_TAR}" -C /opt/node --strip-components=1
  rm -f "${NODE_TAR}"
fi
/opt/node/bin/node --version

echo "== openhuddle ${VERSION} from npm"
/opt/node/bin/npm install -g --no-fund --no-audit "openhuddle@${VERSION}" >/dev/null
/opt/node/bin/node /opt/node/lib/node_modules/openhuddle/bin/openhuddle.js --version

echo "== service user and data dir"
id openhuddle >/dev/null 2>&1 || useradd --system --home /var/lib/openhuddle --shell /usr/sbin/nologin openhuddle
mkdir -p /var/lib/openhuddle/backups
chown -R openhuddle:openhuddle /var/lib/openhuddle
chmod 700 /var/lib/openhuddle

cat > /etc/systemd/system/openhuddle-hub.service <<UNIT
[Unit]
Description=OpenHuddle hub
After=network-online.target
Wants=network-online.target

[Service]
User=openhuddle
Group=openhuddle
ExecStart=/opt/node/bin/node /opt/node/lib/node_modules/openhuddle/bin/openhuddle.js hub --host 127.0.0.1 --port 8787 --db /var/lib/openhuddle/hub.db --backup-dir /var/lib/openhuddle/backups --public-url https://${DOMAIN} --trust-proxy
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/openhuddle
MemoryMax=600M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now openhuddle-hub >/dev/null
systemctl restart openhuddle-hub

echo "== caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
fi
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
CADDY
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

echo "== checks"
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo
systemctl is-active openhuddle-hub caddy
