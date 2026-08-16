# ============================================================
# Enable the APIs the stack uses. disable_on_destroy=false so a
# `terraform destroy` doesn't rip services out from under other resources.
# ============================================================
locals {
  services = [
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sqladmin.googleapis.com",
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "identitytoolkit.googleapis.com", # Firebase Auth / Identity Platform
  ]
}

resource "google_project_service" "enabled" {
  for_each                   = toset(local.services)
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Docker repo the runbook pushes the two app images to.
resource "google_artifact_registry_repository" "miicase" {
  location      = var.region
  repository_id = "miicase"
  format        = "DOCKER"
  description   = "miiCase API + jobs container images"
  depends_on    = [google_project_service.enabled]
}
