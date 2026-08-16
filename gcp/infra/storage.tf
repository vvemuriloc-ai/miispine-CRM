# ============================================================
# Private medical-records bucket. Uniform access + enforced public-access
# prevention (never internet-readable); downloads only via the API's V4 signed
# URLs. Versioning on so an overwrite can't silently destroy a record.
# ============================================================
resource "google_storage_bucket" "records" {
  name                        = var.records_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.enabled]

  versioning {
    enabled = true
  }
}
