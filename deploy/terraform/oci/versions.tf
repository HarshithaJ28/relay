terraform {
  required_version = ">= 1.9"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }

  # State in the bucket made by bootstrap/, through OCI's S3-compatible API. The bucket,
  # endpoint and keys come from backend.hcl and the environment, never from git:
  #   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY = the OCI Customer Secret Key
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    key                         = "relay/terraform.tfstate"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "oci" {
  region = var.region
}
