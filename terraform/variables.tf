variable "proxmox_endpoint" {
  description = "Proxmox API URL, e.g. https://sandpile.local:8006/"
  type        = string
}

variable "proxmox_api_token" {
  description = "Proxmox API token in 'user@realm!tokenid=uuid' form. Set via TF_VAR_proxmox_api_token env var, never commit it."
  type        = string
  sensitive   = true
}

variable "proxmox_node_name" {
  description = "The actual Proxmox cluster node name these worker VMs are created on"
  type        = string
  default     = "optiplex-i5-4750"
}

variable "template_vm_id" {
  description = "VMID of the Debian 13.3.0 cloud-init template to clone from"
  type        = number
  default     = 300
}

variable "worker_nodes" {
  description = "Map of worker VM label -> Docker-host VM config. Each entry becomes one VM on proxmox_node_name."
  type = map(object({
    vm_id   = number
    cores   = number
    memory  = number # MB
    disk_gb = number
    ip_cidr = string # e.g. 10.0.10.11/24
    gateway = string
  }))
  default = {
    # VMIDs 301-399 reserved for these workers. Add more entries here as you
    # scale out — e.g. "worker-2" with vm_id = 302, next free IP, etc.
    "worker-1" = {
      vm_id   = 301
      cores   = 8
      memory  = 16384
      disk_gb = 80
      ip_cidr = "10.0.10.11/24"
      gateway = "10.0.10.1"
    }
  }
}
