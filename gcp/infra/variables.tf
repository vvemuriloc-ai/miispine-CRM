variable "project_id" {
  type        = string
  description = "The miicase-prod GCP project ID (created under the miispine.com org)."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Region for Cloud SQL, Cloud Run, GCS, Scheduler. us-central1 or us-east1 are close to Louisville."
}

variable "db_tier" {
  type        = string
  default     = "db-custom-1-3840"
  description = "Cloud SQL machine type (1 vCPU / 3.75GB). Bump for more load."
}

variable "db_name" {
  type    = string
  default = "miicase"
}

variable "records_bucket_name" {
  type        = string
  description = "Globally-unique name for the private medical-records bucket, e.g. miicase-records-<something>."
}

variable "api_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = "Container image for the API. Defaults to a placeholder for the first apply; the runbook builds the real image and redeploys. Terraform ignores image drift after."
}

variable "jobs_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = "Container image for the jobs service. Placeholder-then-redeploy, same as api_image."
}

variable "cors_origin" {
  type        = string
  default     = "*"
  description = "Allowed browser origin for the API (set to the dashboard's URL in production)."
}

variable "modmed_dry_run" {
  type        = string
  default     = "true"
  description = "Keep 'true' until you've eyeballed a few ModMed sync runs; 'false' lets reconcile write."
}
