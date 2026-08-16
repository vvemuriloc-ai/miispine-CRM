# ============================================================
# Secret Manager. The two DB connection strings are populated by Terraform (it
# knows the generated passwords). The third-party secrets (ModMed, Anthropic,
# SendGrid) are created empty here and their VALUES added by the runbook via
# `gcloud secrets versions add`, so real API keys never land in tfvars or state.
# ============================================================

# --- DB URLs (values set by Terraform) ---
resource "google_secret_manager_secret" "db_app_url" {
  secret_id = "miicase-db-app-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}
resource "google_secret_manager_secret_version" "db_app_url" {
  secret      = google_secret_manager_secret.db_app_url.id
  secret_data = local.app_url
}

resource "google_secret_manager_secret" "db_owner_url" {
  secret_id = "miicase-db-owner-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}
resource "google_secret_manager_secret_version" "db_owner_url" {
  secret      = google_secret_manager_secret.db_owner_url.id
  secret_data = local.owner_url
}

# --- Third-party secrets (values added out-of-band by the runbook) ---
locals {
  external_secrets = [
    "miicase-modmed-base-url",
    "miicase-modmed-api-key",
    "miicase-modmed-username",
    "miicase-modmed-password",
    "miicase-anthropic-api-key",
    "miicase-sendgrid-api-key",
  ]
}

resource "google_secret_manager_secret" "external" {
  for_each  = toset(local.external_secrets)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

# Placeholder versions so Cloud Run's "latest" reference resolves on the first
# apply. The runbook adds the REAL values as newer versions, which the services
# pick up on their next (real-image) deploy.
resource "google_secret_manager_secret_version" "external_placeholder" {
  for_each    = google_secret_manager_secret.external
  secret      = each.value.id
  secret_data = "REPLACE_ME"
}
