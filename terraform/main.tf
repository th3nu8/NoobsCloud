terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.66"
    }
  }
}

provider "proxmox" {
  endpoint  = var.proxmox_endpoint
  api_token = var.proxmox_api_token
  insecure  = true # set false once you have a real cert on the Proxmox API
}

# Multiple Docker-host VMs on the same Proxmox node (var.proxmox_node_name),
# each cloned from a cloud-init-enabled Debian 13.3.0 (Trixie) template
# (see README step 2). VMIDs 301-399 reserved for these workers.
resource "proxmox_virtual_environment_vm" "docker_host" {
  for_each = var.worker_nodes

  name      = "noobscloud-${each.key}"
  node_name = var.proxmox_node_name
  vm_id     = each.value.vm_id

  clone {
    vm_id = var.template_vm_id
    full  = true
  }

  cpu {
    cores = each.value.cores
    type  = "host" # required for nested virt / binder module compatibility
  }

  memory {
    dedicated = each.value.memory
  }

  disk {
    datastore_id = "local-lvm"
    interface    = "scsi0"
    size         = each.value.disk_gb
  }

  # GPU passthrough: uncomment and set to your card's PCI address per node
  # hostpci {
  #   device = "hostpci0"
  #   id     = "0000:01:00.0"
  #   pcie   = true
  # }

  initialization {
    ip_config {
      ipv4 {
        address = each.value.ip_cidr
        gateway = each.value.gateway
      }
    }
    user_account {
      username = "deploy"
      keys     = [file("~/.ssh/id_ed25519.pub")]
    }
  }

  agent {
    enabled = true
  }
}

output "worker_ips" {
  value = { for k, v in var.worker_nodes : k => split("/", v.ip_cidr)[0] }
}
