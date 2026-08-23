# syntax=docker/dockerfile:1
# Jedi Knight: Jedi Academy — thin static image for jka.virtastic.app.
# The wasm/js are gitignored build products (built with the pinned Homebrew emcc 6.0.1) and are
# staged into play/jka/ in the build context by the deploy workflow (rsync'd onto the runner),
# exactly like openmw-web bakes its rsync'd demo data. This image just serves that tree with the
# COOP/COEP headers cross-origin isolation requires; html no-store + indexable, mirroring ja2-web.
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="jka" \
      org.opencontainers.image.description="Jedi Knight: Jedi Academy — WebAssembly port" \
      org.opencontainers.image.licenses="GPL-2.0-or-later"
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY play/jka/ /usr/share/nginx/html/
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
