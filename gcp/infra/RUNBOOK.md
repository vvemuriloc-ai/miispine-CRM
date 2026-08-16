# miiCase go-live runbook (Google Cloud)

Brings the whole system up on the `miicase-prod` project. Terraform provisions
the durable infra; a few `gcloud` steps build the apps, load the schema, and wire
Firebase. **Nothing bills until Step 3 (Cloud SQL) — that's where cost starts
(~$60–180/mo, mostly Cloud SQL).**

> Prereq for real patients: the **HIPAA BAA must be accepted** (admin.google.com →
> Account → Legal & compliance) before Step 8's data load. Everything up to then
> uses synthetic/seed data, so you can stand the system up first and load real
> data last.

## 0. Prerequisites

```bash
# Install the CLIs (once): gcloud (cloud.google.com/sdk), terraform,
# cloud-sql-proxy (cloud.google.com/sql/docs/postgres/sql-proxy), and psql.
gcloud auth login                       # sign in as gcpadmin@miispine.com
gcloud config set project miicase-prod
gcloud auth application-default login   # credentials Terraform will use
```

## 1. Enable billing

Console → Billing → link a billing account to `miicase-prod`. (Free until Step 3.)

## 2. Configure Terraform

```bash
cd gcp/infra
cp terraform.tfvars.example terraform.tfvars
# edit: project_id, region, and a globally-unique records_bucket_name
```

## 3. Apply the infrastructure  ← cost starts here

```bash
terraform init
terraform apply       # creates Cloud SQL, GCS, service accounts, secrets,
                      # Cloud Run (placeholder images), and Cloud Scheduler
```

Note the outputs: `api_url`, `jobs_url`, `sql_connection_name`, `artifact_repo`,
`records_bucket`.

## 4. Add the real secret values

The DB URLs are already set by Terraform. Add the third-party ones (skip SendGrid
to keep autopilot in dry-run; skip ModMed for now if you don't have PM access yet):

```bash
printf '%s' 'https://<env>.ema-api.com/.../ema/fhir/v2' | gcloud secrets versions add miicase-modmed-base-url --data-file=-
printf '%s' '<modmed-x-api-key>'  | gcloud secrets versions add miicase-modmed-api-key  --data-file=-
printf '%s' '<modmed-username>'   | gcloud secrets versions add miicase-modmed-username --data-file=-
printf '%s' '<modmed-password>'   | gcloud secrets versions add miicase-modmed-password --data-file=-
printf '%s' 'sk-ant-...'          | gcloud secrets versions add miicase-anthropic-api-key --data-file=-
printf '%s' 'SG....'              | gcloud secrets versions add miicase-sendgrid-api-key   --data-file=-
```

## 5. Build & deploy the two apps

```bash
REPO=$(terraform output -raw artifact_repo)
REGION=$(terraform output -raw sql_connection_name | cut -d: -f2)

# API
( cd ../api    && gcloud builds submit --tag "$REPO/api:v1" . )
gcloud run deploy miicase-api  --image "$REPO/api:v1"  --region "$REGION"

# Jobs
( cd ../functions && gcloud builds submit --tag "$REPO/jobs:v1" . )
gcloud run deploy miicase-jobs --image "$REPO/jobs:v1" --region "$REGION"
```

(Terraform ignores image drift, so these deploys won't fight `terraform apply`.)

## 6. Load the schema

```bash
# Cloud SQL Auth Proxy in one terminal (uses your ADC credentials):
cloud-sql-proxy "$(terraform output -raw sql_connection_name)" &

# Owner password from the secret Terraform created:
PGPASSWORD=$(gcloud secrets versions access latest --secret=miicase-db-owner-url \
  | sed -E 's#.*postgres:([^@]*)@.*#\1#')
PSQL="psql host=127.0.0.1 port=5432 user=postgres dbname=miicase"

for f in ../db/migrations/0*.sql; do PGPASSWORD=$PGPASSWORD $PSQL -v ON_ERROR_STOP=1 -f "$f"; done
PGPASSWORD=$PGPASSWORD $PSQL -f ../db/roles.sql   # grants to the miicase_app user
```

## 7. Firebase (sign-in)

1. **[console.firebase.google.com](https://console.firebase.google.com)** → **Add project → select existing** `miicase-prod`.
2. **Authentication → Sign-in method → enable Email/Password.**
3. **Project settings → Your apps → add a Web app** → copy the config
   (`apiKey`, `authDomain`, `projectId`).
4. Create your staff logins (Authentication → Users → Add user), note each **UID**.
5. Map users to firms/staff (proxy + psql still running):

```bash
# miiSpine staff (sees the whole book):
PGPASSWORD=$PGPASSWORD $PSQL -c "select assign_staff('<firebase-uid>','ar@miispine.com');"
# An attorney scoped to one firm:
PGPASSWORD=$PGPASSWORD $PSQL -c "select assign_user_to_firm('<uid>','atty@firm.com','<firm-uuid>','staff');"
```

## 8. Point the dashboard at the API + ship it

Edit `gcp/web/index.html`:

```js
const API_BASE = "<terraform output api_url>";
const FIREBASE_CONFIG = { apiKey: "…", authDomain: "…", projectId: "miicase-prod" };
```

Also set `cors_origin` in `terraform.tfvars` to wherever you host the page, and
`terraform apply`. Host `index.html` on **Firebase Hosting** (`firebase deploy`) or
any static host. Then sign in and confirm you see `Live · N cases`.

## 9. Load real data (BAA must be accepted first)

1. Import the legacy workbook (see the main README "Importing the legacy
   spreadsheet") through the proxy + psql — PHI stays between your machine and the
   covered DB.
2. Link cases to ModMed: `update cases set emr_patient_id = … `.
3. Dry-run the ModMed jobs, review `emr_sync_status`, then set
   `modmed_dry_run = "false"` in tfvars, `terraform apply`, and redeploy jobs.

## Teardown / cost control

- Pause spend: `gcloud sql instances patch miicase-pg --activation-policy=NEVER`
  (stops the instance; storage still bills a little).
- Full teardown: set `deletion_protection = false` on the instance, then
  `terraform destroy`. **This deletes the database** — back up first.
