# ============================================================
# Service accounts + least-privilege IAM.
#   api_sa       — Cloud Run API identity (RLS-enforced app user)
#   jobs_sa      — Cloud Run jobs identity (owner DB user; ModMed + GCS)
#   scheduler_sa — Cloud Scheduler identity (only invokes the jobs service)
# ============================================================
resource "google_service_account" "api" {
  account_id   = "miicase-api"
  display_name = "miiCase API (Cloud Run)"
}
resource "google_service_account" "jobs" {
  account_id   = "miicase-jobs"
  display_name = "miiCase jobs (Cloud Run)"
}
resource "google_service_account" "scheduler" {
  account_id   = "miicase-scheduler"
  display_name = "miiCase Cloud Scheduler"
}

# --- Cloud SQL client (both apps) ---
resource "google_project_iam_member" "api_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}
resource "google_project_iam_member" "jobs_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.jobs.email}"
}

# --- GCS records bucket ---
resource "google_storage_bucket_iam_member" "api_bucket" {
  bucket = google_storage_bucket.records.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}
resource "google_storage_bucket_iam_member" "jobs_bucket" {
  bucket = google_storage_bucket.records.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.jobs.email}"
}

# The API mints V4 signed URLs without a service-account key by asking IAM to
# sign on its behalf — needs the Token Creator role ON ITSELF.
resource "google_service_account_iam_member" "api_sign" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# --- Secret access (per-secret, least privilege) ---
resource "google_secret_manager_secret_iam_member" "api_db" {
  secret_id = google_secret_manager_secret.db_app_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
resource "google_secret_manager_secret_iam_member" "jobs_db" {
  secret_id = google_secret_manager_secret.db_owner_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}
# Jobs read every third-party secret (ModMed/Anthropic/SendGrid).
resource "google_secret_manager_secret_iam_member" "jobs_external" {
  for_each  = google_secret_manager_secret.external
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}
