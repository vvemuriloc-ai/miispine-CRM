terraform {
  required_version = ">= 1.5"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 6.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 6.0" }
    random      = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id # bill/quota API calls to this project,
  user_project_override = true           # not whatever gcloud's active project is
}

provider "google-beta" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}
