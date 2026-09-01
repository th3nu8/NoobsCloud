variable "proxmox_endpoint" {
  description = "Proxmox API URL, e.g. https://sandpile.local:8006/"
  type        = string
}

variable "proxmox_api_token" {
  description = "Proxmox API token in 'user@realm!tokenid=uuid' form. Set via TF_VAR_proxmox_api_token env var, never commit it."
  type        = string
  sensitive   = true
}

variable "worker_nodes" {
  description = "Map of Proxmox node name -> Docker-host VM config to create on it"
  type = map(object({
    vm_id   = number
    cores   = number
    memory  = number # MB
    disk_gb = number
    ip_cidr = string # e.g. 10.0.10.11/24
    gateway = string
  }))
  default = {
    "pve-node1" = {
      vm_id   = 9101
      cores   = 8
      memory  = 16384
      disk_gb = 80
      ip_cidr = "10.0.10.11/24"
      gateway = "10.0.10.1"
    }
  }
}
