# Cloudflare DNS for jka.virtastic.app (the Jedi Knight: Jedi Academy preview on the shared OVH VPS).
# Auth: export CLOUDFLARE_API_TOKEN=... (Zone:Read, DNS:Edit, Cache Rules:Edit on virtastic.app).
#   terraform init && terraform apply
terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.30" }
  }
}

provider "cloudflare" {}  # reads CLOUDFLARE_API_TOKEN from the environment

data "cloudflare_zone" "this" { name = var.zone_name }

# DNS only. (The zone's edge cache ruleset lives in the single per-zone
# `http_request_cache_settings` entrypoint, already owned out-of-band; we do NOT manage it here to
# avoid clobbering it.) The origin already sends immutable Cache-Control on wasm/js/data/pk3.
resource "cloudflare_record" "jka" {
  zone_id = data.cloudflare_zone.this.id
  name    = "jka"
  type    = "A"
  content = var.origin_ip
  proxied = true
  ttl     = 1
  comment = "Jedi Knight: Jedi Academy preview on the shared OVH VPS (managed by terraform)"
}
