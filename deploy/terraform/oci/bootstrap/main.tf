# One-time stack: the Object Storage bucket that holds the main stack's state.
# Its own state stays local (it is tiny and rarely changes); keep it out of git.
#
#   terraform init && terraform apply
#
# Then create a Customer Secret Key for your user in the OCI console (Identity >
# Users > Customer secret keys). The main stack reaches this bucket through OCI's
# S3-compatible API with that key.

terraform {
  required_version = ">= 1.9"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

provider "oci" {
  region = var.region
}

variable "region" {
  type        = string
  description = "Home region, for example us-ashburn-1."
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment for the bucket."
}

variable "bucket_name" {
  type    = string
  default = "relay-tfstate"
}

data "oci_objectstorage_namespace" "this" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "state" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = var.bucket_name
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"
}

output "namespace" {
  value = data.oci_objectstorage_namespace.this.namespace
}

output "bucket" {
  value = oci_objectstorage_bucket.state.name
}

output "s3_endpoint" {
  value = "https://${data.oci_objectstorage_namespace.this.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
}
