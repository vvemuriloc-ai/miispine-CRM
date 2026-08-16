# ============================================================
# Cloud Run services. Both reach Cloud SQL via the built-in connector (Unix
# socket at /cloudsql). Image starts as a placeholder; the runbook builds the
# real image and redeploys, and Terraform ignores image drift thereafter.
#
#   api  — public endpoint (allUsers invoker); the app itself enforces Firebase
#          auth on every request, so "public" only means "reachable", not "open".
#   jobs — reachable but private: only the scheduler service account may invoke.
# ============================================================

resource "google_cloud_run_v2_service" "api" {
  name                = "miicase-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  depends_on          = [google_project_service.enabled, google_secret_manager_secret_version.db_app_url]

  template {
    service_account = google_service_account.api.email
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.conn]
      }
    }
    containers {
      image = var.api_image
      ports {
        container_port = 8080
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "AUTH_MODE"
        value = "firebase"
      }
      env {
        name  = "STORAGE_MODE"
        value = "gcs"
      }
      env {
        name  = "RECORDS_BUCKET"
        value = google_storage_bucket.records.name
      }
      env {
        name  = "CORS_ORIGIN"
        value = var.cors_origin
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_app_url.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
}

# The API is internet-reachable; Firebase-token checks in the app are the gate.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "jobs" {
  name                = "miicase-jobs"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_version.db_owner_url,
    google_secret_manager_secret_version.external_placeholder,
  ]

  template {
    service_account = google_service_account.jobs.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    timeout = "900s" # long enough for a nightly sync over many patients
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.conn]
      }
    }
    containers {
      image = var.jobs_image
      ports {
        container_port = 8080
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "RECORDS_BUCKET"
        value = google_storage_bucket.records.name
      }
      env {
        name  = "MODMED_DRY_RUN"
        value = var.modmed_dry_run
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_owner_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = local.jobs_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
}

# Only the scheduler SA may invoke the jobs service (no allUsers).
resource "google_cloud_run_v2_service_iam_member" "jobs_scheduler" {
  name     = google_cloud_run_v2_service.jobs.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

locals {
  jobs_secret_env = {
    MODMED_BASE_URL   = "miicase-modmed-base-url"
    MODMED_API_KEY    = "miicase-modmed-api-key"
    MODMED_USERNAME   = "miicase-modmed-username"
    MODMED_PASSWORD   = "miicase-modmed-password"
    ANTHROPIC_API_KEY = "miicase-anthropic-api-key"
    SENDGRID_API_KEY  = "miicase-sendgrid-api-key"
  }
}
