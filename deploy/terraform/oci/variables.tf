variable "region" {
  type        = string
  description = "Home region (Always Free Ampere capacity is only in the home region)."
}

variable "compartment_ocid" {
  type = string
}

variable "ssh_public_key" {
  type        = string
  description = "Public key for the ubuntu user."
}

variable "admin_cidr" {
  type        = string
  description = "The only address range allowed to reach SSH and the Kubernetes API, e.g. 203.0.113.4/32."
  validation {
    condition     = can(cidrnetmask(var.admin_cidr)) && var.admin_cidr != "0.0.0.0/0"
    error_message = "admin_cidr must be a CIDR range and must not be 0.0.0.0/0."
  }
}

# Always Free: up to 4 OCPUs and 24 GB across all Ampere A1 instances. Check the current
# allowance in your tenancy before applying.
variable "ocpus" {
  type    = number
  default = 2
  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 4
    error_message = "ocpus must be between 1 and 4 to stay inside the Always Free allowance."
  }
}

variable "memory_gb" {
  type    = number
  default = 12
  validation {
    condition     = var.memory_gb >= 1 && var.memory_gb <= 24
    error_message = "memory_gb must be between 1 and 24 to stay inside the Always Free allowance."
  }
}

variable "boot_volume_gb" {
  type    = number
  default = 50
  validation {
    condition     = var.boot_volume_gb >= 50 && var.boot_volume_gb <= 200
    error_message = "boot_volume_gb must be between 50 and 200 (the Always Free block storage total)."
  }
}

variable "k3s_version" {
  type    = string
  default = "v1.31.4+k3s1"
}
