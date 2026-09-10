# Deploying to Google Cloud Run

This app runs as a single container on Cloud Run, backed by Neon Postgres.
Deploys are driven by [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
on every push to `main`.

The pipeline is: build image → push to Artifact Registry → apply Prisma
migrations → deploy a revision **with no traffic** → smoke-test it → shift 100%
of traffic. A failed smoke test leaves the previous revision serving.

Throughout, replace the placeholders:

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `PROJECT_ID` | GCP project | `contrarian-prod` |
| `PROJECT_NUMBER` | GCP project number (not the ID) | `123456789012` |
| `REGION` | Cloud Run region | `us-central1` |
| `SERVICE` | Cloud Run service name | `contrarian-product-rules` |
| `AR_REPO` | Artifact Registry repo | `apps` |
| `GH_OWNER/GH_REPO` | This repository | `TheBigChewbacca/contrarian-product-rules` |

---

## 1. One-time GCP setup

### Enable APIs

```bash
gcloud config set project PROJECT_ID

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

### Create the Artifact Registry repository

```bash
gcloud artifacts repositories create AR_REPO \
  --repository-format=docker \
  --location=REGION \
  --description="Container images for Contrarian apps"
```

### Create the two service accounts

The **runtime** account is what the container runs as. It needs almost nothing,
because the app talks only to Shopify and Neon over the public internet — it just
needs to read its own secrets.

```bash
gcloud iam service-accounts create cpr-runtime \
  --display-name="Contrarian Product Rules runtime"
```

The **deployer** account is what GitHub Actions impersonates.

```bash
gcloud iam service-accounts create gh-deployer \
  --display-name="GitHub Actions deployer"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:gh-deployer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:gh-deployer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# Required so the deployer can deploy a service that *runs as* the runtime SA.
gcloud iam service-accounts add-iam-policy-binding \
  cpr-runtime@PROJECT_ID.iam.gserviceaccount.com \
  --member="serviceAccount:gh-deployer@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

### Store runtime configuration in Secret Manager

Every value the app reads at runtime lives here — nothing sensitive is set on
the Cloud Run service directly, and nothing sensitive is committed.

```bash
# Neon POOLED connection string (host contains "-pooler").
printf '%s' 'postgresql://...-pooler.../neondb?sslmode=require' \
  | gcloud secrets create cpr-database-url --data-file=-

# Neon DIRECT (non-pooled) connection string.
printf '%s' 'postgresql://.../neondb?sslmode=require' \
  | gcloud secrets create cpr-direct-url --data-file=-

printf '%s' 'YOUR_SHOPIFY_API_KEY'    | gcloud secrets create cpr-shopify-api-key --data-file=-
printf '%s' 'YOUR_SHOPIFY_API_SECRET' | gcloud secrets create cpr-shopify-api-secret --data-file=-

# Set this to the Render URL for now; step 4 replaces it after the first deploy.
printf '%s' 'https://contrarian-product-rules.onrender.com' \
  | gcloud secrets create cpr-shopify-app-url --data-file=-

printf '%s' 'read_products,write_products,read_orders,write_orders,read_shipping,write_shipping,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders' \
  | gcloud secrets create cpr-scopes --data-file=-
```

Grant the runtime account read access to each:

```bash
for SECRET in cpr-database-url cpr-direct-url cpr-shopify-api-key \
              cpr-shopify-api-secret cpr-shopify-app-url cpr-scopes; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:cpr-runtime@PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

### Set up Workload Identity Federation

This is what lets GitHub Actions authenticate without a downloaded service
account key.

```bash
gcloud iam workload-identity-pools create github \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == 'GH_OWNER/GH_REPO'"
```

The `--attribute-condition` is what stops any other repository on GitHub from
minting tokens for this project. Do not omit it.

Bind the deployer account to this repository:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  gh-deployer@PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/GH_OWNER/GH_REPO"
```

---

## 2. Configure the GitHub repository

Under **Settings → Secrets and variables → Actions**:

**Variables** (not secret — these appear in build logs):

| Name | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `PROJECT_ID` |
| `GCP_REGION` | `REGION` |
| `GCP_ARTIFACT_REPOSITORY` | `AR_REPO` |
| `CLOUD_RUN_SERVICE` | `SERVICE` |
| `GCP_SERVICE_ACCOUNT` | `gh-deployer@PROJECT_ID.iam.gserviceaccount.com` |
| `CLOUD_RUN_RUNTIME_SA` | `cpr-runtime@PROJECT_ID.iam.gserviceaccount.com` |
| `GCP_WORKLOAD_IDP` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-provider` |

**Secrets:**

| Name | Value |
| --- | --- |
| `PRISMA_DIRECT_URL` | The Neon **direct** (non-pooled) connection string |

Migrations run from the GitHub runner rather than from the container, so the
runner needs its own copy of the direct URL. Neon is reachable over the public
internet, so no additional networking is required.

---

## 3. First deploy

Push to `main`, or run the **Deploy to Cloud Run** workflow manually from the
Actions tab. Then read the service URL:

```bash
gcloud run services describe SERVICE --region REGION \
  --format='value(status.url)'
```

---

## 4. Point Shopify at Cloud Run

Two places must agree, and both must match the Cloud Run URL exactly.

**a. `SHOPIFY_APP_URL`** — update the secret and redeploy so the new revision
picks it up:

```bash
printf '%s' 'https://SERVICE-xxxxxxxxxx-uc.a.run.app' \
  | gcloud secrets versions add cpr-shopify-app-url --data-file=-
```

**b. `shopify.app.toml`** — replace all four `onrender.com` references:

```toml
application_url = "https://SERVICE-xxxxxxxxxx-uc.a.run.app"

[auth]
redirect_urls = [
  "https://SERVICE-xxxxxxxxxx-uc.a.run.app/auth/callback",
  "https://SERVICE-xxxxxxxxxx-uc.a.run.app/auth/shopify/callback",
  "https://SERVICE-xxxxxxxxxx-uc.a.run.app/api/auth/callback"
]
```

Then push the app configuration to Shopify:

```bash
npm run deploy
```

That command also deploys the theme app extension. Note that
`[build] automatically_update_urls_on_dev = true` means a local `shopify app dev`
session will rewrite `application_url` to a tunnel URL — check that file before
committing after any dev session.

> If you would rather serve the app from a custom domain, map it first
> (`gcloud beta run domain-mappings create --service SERVICE --domain app.example.com`),
> wait for the certificate to provision, and use that hostname in both places
> instead of the `run.app` URL. Doing it in that order avoids re-authorising the
> app twice.

---

## 5. Cutover from Render

1. Deploy to Cloud Run and confirm `/healthz` returns 200.
2. Update `SHOPIFY_APP_URL` and `shopify.app.toml`, then `npm run deploy` (step 4).
3. Open the app in the Shopify admin. Because the app URL changed, you will be
   taken through OAuth again — sessions live in Postgres and both hosts share the
   same Neon database, so no session data is lost.
4. Place a test order against a preorder product and confirm the order is tagged
   and its fulfillment order goes `ON_HOLD`. This exercises the `orders/create`
   webhook against the new URL.
5. Watch logs for a few hours:
   ```bash
   gcloud run services logs tail SERVICE --region REGION
   ```
6. Only then scale the Render service to zero. **Keep it deployable for about a
   week** — it is the fastest rollback if something only shows up under real
   traffic.

---

## Operational notes

### Migrations

`prisma migrate deploy` runs once per release, from the GitHub runner, before
traffic shifts. It is deliberately **not** in the container start command: Cloud
Run starts many instances concurrently and they would race each other, and
migration time would be charged against the startup timeout on every cold start.

A migration must therefore be backwards-compatible with the currently-running
revision, since it is applied while the old code is still serving. For an additive
column that is automatic. For a rename or a drop, use the usual expand/contract
pattern across two deploys.

### Neon connection pooling

Cloud Run creates many short-lived instances, each with its own Prisma client.
Always point `DATABASE_URL` at the **pooled** Neon endpoint (`-pooler` in the
hostname) or you will exhaust Postgres connections under load. `DIRECT_URL` uses
the non-pooled endpoint because Prisma's migration engine needs a real session.

### Sizing

The service is configured with `--min-instances 1`. Shopify webhooks and embedded
admin requests are both latency-sensitive, and a cold start here includes a Neon
connection handshake. If cost matters more than tail latency, drop it to 0.

`--timeout 300` matters for the "Check assignments" audit on the Product rules
page: it paginates the entire product catalog inside a single request, so a large
catalog needs the headroom.

### Rollback

```bash
# List revisions, newest first.
gcloud run revisions list --service SERVICE --region REGION

# Send all traffic back to a known-good one.
gcloud run services update-traffic SERVICE --region REGION \
  --to-revisions REVISION_NAME=100
```

Rolling back code does **not** roll back the database. If the bad release
included a destructive migration, restore from a Neon branch/point-in-time
restore first.

### Logs

```bash
gcloud run services logs tail SERVICE --region REGION
```

Application logs go to Cloud Logging automatically via stdout/stderr. Log volume
is billed, so avoid logging full payloads on hot paths.
