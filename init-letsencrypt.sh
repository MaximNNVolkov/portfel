#!/bin/sh
# One-time bootstrap for Let's Encrypt certificates via docker-compose + certbot.
# Standard "dummy cert -> real cert" dance: nginx refuses to start with an ssl_certificate
# directive pointing at a file that doesn't exist yet, so we create a self-signed placeholder,
# start nginx, request the real certificate over that, then reload nginx with the real one.
#
# Usage: DOMAIN=example.com EMAIL=you@example.com ./init-letsencrypt.sh
set -eu

: "${DOMAIN:?Set DOMAIN=your.domain.com}"
: "${EMAIL:?Set EMAIL=you@example.com}"

COMPOSE="docker compose"
LIVE_PATH="./certbot/conf/live/$DOMAIN"

echo "### Creating dummy certificate for $DOMAIN ..."
mkdir -p "$LIVE_PATH"
docker run --rm -v "$(pwd)/certbot/conf:/etc/letsencrypt" alpine/openssl req -x509 -nodes \
  -newkey rsa:2048 -days 1 \
  -keyout "/etc/letsencrypt/live/$DOMAIN/privkey.pem" \
  -out "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" \
  -subj "/CN=localhost"

echo "### Starting nginx with dummy certificate ..."
DOMAIN="$DOMAIN" $COMPOSE up -d nginx

echo "### Deleting dummy certificate ..."
docker run --rm -v "$(pwd)/certbot/conf:/etc/letsencrypt" alpine \
  rm -rf "/etc/letsencrypt/live/$DOMAIN" "/etc/letsencrypt/archive/$DOMAIN" "/etc/letsencrypt/renewal/$DOMAIN.conf"

echo "### Requesting real certificate from Let's Encrypt ..."
docker run --rm \
  -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  --email "$EMAIL" -d "$DOMAIN" --rsa-key-size 4096 --agree-tos --non-interactive

echo "### Reloading nginx with the real certificate ..."
DOMAIN="$DOMAIN" $COMPOSE exec nginx nginx -s reload

echo "### Done. Certbot will auto-renew via the 'certbot' compose service."
