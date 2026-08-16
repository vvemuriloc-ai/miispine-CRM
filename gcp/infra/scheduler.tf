# ============================================================
# Cloud Scheduler — nightly triggers that POST to the jobs service with an OIDC
# token for the scheduler SA (the only identity allowed to invoke it).
#   05:00 UTC  records sync   (clinical documents → GCS)
#   05:30 UTC  AR sync        (charges + payments → liens)
#   06:00 UTC  autopilot      (attorney outreach)
# ============================================================
locals {
  jobs_url = google_cloud_run_v2_service.jobs.uri
  cron = {
    "modmed-records" = "0 5 * * *"
    "modmed-sync"    = "30 5 * * *"
    "autopilot"      = "0 6 * * *"
  }
}

resource "google_cloud_scheduler_job" "jobs" {
  for_each  = local.cron
  name      = "miicase-${each.key}"
  region    = var.region
  schedule  = each.value
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "${local.jobs_url}/jobs/${each.key}"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.jobs_url
    }
  }

  retry_config {
    retry_count = 1
  }

  depends_on = [google_project_service.enabled]
}
