# AWS equivalent of oci/, for comparison only. CI runs fmt, validate and tflint on it and
# never applies it. State is local and must not be committed. Apply only on purpose, after
# the billing alert below exists and the current free-tier terms have been checked:
#
#   terraform init && terraform apply -target=aws_budgets_budget.alert
#   terraform apply

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "relay" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "ssh_public_key" {
  type = string
}

variable "admin_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.admin_cidr)) && var.admin_cidr != "0.0.0.0/0"
    error_message = "admin_cidr must be a CIDR range and must not be 0.0.0.0/0."
  }
}

variable "billing_alert_email" {
  type        = string
  description = "Gets an email when forecast monthly spend passes the limit."
}

variable "monthly_limit_usd" {
  type    = string
  default = "1"
}

variable "instance_type" {
  type    = string
  default = "t4g.small"
}

variable "k3s_version" {
  type    = string
  default = "v1.31.4+k3s1"
}

resource "aws_budgets_budget" "alert" {
  name         = "relay-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_limit_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.billing_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 1
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.billing_alert_email]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
}

resource "aws_key_pair" "relay" {
  key_name   = "relay"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "relay" {
  name        = "relay"
  description = "Relay node: web from anywhere, SSH and the Kubernetes API from admin_cidr"

  ingress {
    description = "http"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "https"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "kubernetes api"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  # Webhook workers must reach arbitrary public HTTPS endpoints; outbound limits are
  # enforced per pod by the chart's NetworkPolicy instead.
  #trivy:ignore:AVD-AWS-0104
  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "relay" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.relay.key_name
  vpc_security_group_ids = [aws_security_group.relay.id]

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOT
    #!/bin/sh
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='${var.k3s_version}' sh -s - --write-kubeconfig-mode 600 --secrets-encryption
  EOT
}

output "public_ip" {
  value = aws_instance.relay.public_ip
}
