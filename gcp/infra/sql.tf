# ============================================================
# Cloud SQL for PostgreSQL 16. Reached by Cloud Run over the built-in Cloud SQL
# connector (Unix socket at /cloudsql), so no public network exposure is needed:
# a public IP is enabled for the connector but NO authorized networks are added,
# and SSL is required. PITR + daily backups on for the 6-year PHI retention posture.
# ============================================================
resource "random_password" "owner" {
  length  = 32
  special = false
}

resource "random_password" "app" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "miicase" {
  name                = "miicase-pg"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_project_service.enabled]

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # switch to REGIONAL for HA once live
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "07:00" # UTC (~2am Louisville)
      transaction_log_retention_days = 7
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
      # No authorized_networks: the instance is not reachable from the internet;
      # Cloud Run connects via the Cloud SQL Auth Proxy over Google's network.
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }
}

resource "google_sql_database" "miicase" {
  name     = var.db_name
  instance = google_sql_database_instance.miicase.name
}

# Owner/admin user — migrations and the background jobs connect as this (bypasses
# RLS, the service_role equivalent).
resource "google_sql_user" "owner" {
  name     = "postgres"
  instance = google_sql_database_instance.miicase.name
  password = random_password.owner.result
}

# Application user — the API connects as this; RLS is enforced against it.
resource "google_sql_user" "app" {
  name     = "miicase_app"
  instance = google_sql_database_instance.miicase.name
  password = random_password.app.result
}

locals {
  conn      = google_sql_database_instance.miicase.connection_name
  app_url   = "postgresql://miicase_app:${random_password.app.result}@/${var.db_name}?host=/cloudsql/${local.conn}"
  owner_url = "postgresql://postgres:${random_password.owner.result}@/${var.db_name}?host=/cloudsql/${local.conn}"
}
