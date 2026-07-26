variable "zone_name" { type = string, default = "virtastic.app" }
variable "hostname"  { type = string, default = "jka.virtastic.app" }
variable "origin_ip" {
  description = "Origin OVH VPS IPv4 (DNS A target). Sensitive — supply via gitignored terraform.tfvars or TF_VAR_origin_ip; never commit."
  type        = string
}
