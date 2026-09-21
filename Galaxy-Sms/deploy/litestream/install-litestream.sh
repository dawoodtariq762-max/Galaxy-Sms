#!/usr/bin/env bash
# PowerX — install Litestream (static binary, no package manager needed)
set -euo pipefail
VERSION="${LITESTREAM_VERSION:-v0.3.13}"
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH=amd64
echo "• downloading litestream ${VERSION} linux-${ARCH}..."
curl -sL -o /tmp/litestream.tar.gz \
  "https://github.com/benbjohnson/litestream/releases/download/${VERSION}/litestream-${VERSION}-linux-${ARCH}.tar.gz"
tar -xzf /tmp/litestream.tar.gz -C /tmp
sudo install -m 0755 /tmp/litestream /usr/local/bin/litestream
rm -f /tmp/litestream /tmp/litestream.tar.gz
/usr/local/bin/litestream version && echo "✓ installed. Next: cp deploy/litestream/litestream.yml /etc/litestream.yml"
