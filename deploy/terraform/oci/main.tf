# One Always Free Ampere A1 machine running k3s, in its own VCN. Public: 80 and 443.
# SSH and the Kubernetes API: admin_cidr only.

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "relay" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "relay"
  dns_label      = "relay"
}

resource "oci_core_internet_gateway" "relay" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.relay.id
  display_name   = "relay"
}

resource "oci_core_route_table" "relay" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.relay.id
  display_name   = "relay"
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.relay.id
  }
}

resource "oci_core_security_list" "relay" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.relay.id
  display_name   = "relay"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = { http = 80, https = 443 }
    content {
      description = ingress_security_rules.key
      source      = "0.0.0.0/0"
      protocol    = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }

  dynamic "ingress_security_rules" {
    for_each = { ssh = 22, kubernetes = 6443 }
    content {
      description = ingress_security_rules.key
      source      = var.admin_cidr
      protocol    = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }
}

resource "oci_core_subnet" "relay" {
  compartment_id    = var.compartment_ocid
  vcn_id            = oci_core_vcn.relay.id
  cidr_block        = "10.0.1.0/24"
  display_name      = "relay"
  dns_label         = "nodes"
  route_table_id    = oci_core_route_table.relay.id
  security_list_ids = [oci_core_security_list.relay.id]
}

resource "oci_core_instance" "relay" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "relay"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.relay.id
    assign_public_ip = true
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      k3s_version = var.k3s_version
    }))
  }
}

output "public_ip" {
  value       = oci_core_instance.relay.public_ip
  description = "Point the DuckDNS name here, and add it as a /32 to the chart's networkPolicy.extraBlockedCidrs."
}
