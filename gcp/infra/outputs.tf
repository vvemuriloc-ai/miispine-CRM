output "api_url" {
  value       = google_cloud_run_v2_service.api.uri
  description = "Public API base URL — put this in gcp/web/index.html API_BASE."
}

output "jobs_url" {
  value       = google_cloud_run_v2_service.jobs.uri
  description = "Jobs service URL (invoked only by Cloud Scheduler)."
}

output "sql_connection_name" {
  value       = google_sql_database_instance.miicase.connection_name
  description = "Cloud SQL instance connection name (PROJECT:REGION:INSTANCE) for the Auth Proxy."
}

output "records_bucket" {
  value = google_storage_bucket.records.name
}

output "api_service_account" {
  value = google_service_account.api.email
}

output "jobs_service_account" {
  value = google_service_account.jobs.email
}

output "artifact_repo" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.miicase.repository_id}"
  description = "Push the API + jobs images here."
}
