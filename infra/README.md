# AegisWeb run memory on AWS

This is the optional cloud half of AegisWeb's cross-run memory. The stage demo is
fully local: **you do not need AWS, credentials, or a deployment** to run it.

When `AEGIS_CLOUD_URL` is set, the agent POSTs a compact run record after each
mission. That gives the project a real, inspectable AWS path:

```
AegisWeb agent ──POST /runs──▶ API Gateway HTTP API ──▶ Lambda ──▶ DynamoDB
                                   (CORS, stage)        (handler.py)   (runId key)
```

The dashboard and local `artifacts/latest/memory.json` remain the source of truth.
Cloud sync is best-effort and a failure never fails the mission.

## What gets deployed

| Resource | Purpose |
| --- | --- |
| `AegisHttpApi` | HTTP API with CORS, routes `POST /runs`, `GET /runs`, `GET /runs/{runId}` |
| `AegisMemoryFunction` | Python 3.12 Lambda in `lambda/handler.py` |
| `AegisRunsTable` | On-demand DynamoDB table, encrypted at rest, partition key `runId` |

## Deploy

Prerequisites: [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
AWS credentials (`aws sts get-caller-identity` should work), and Python 3.12 for
`sam build` (or use `--use-container`).

```bash
cd infra
sam validate --lint
sam build
sam deploy --guided \
  --stack-name aegisweb-memory \
  --parameter-overrides StageName=prod AllowedOrigin='*' ApiToken=''
```

For a shared/public deployment, set a bearer token and restrict CORS:

```bash
sam deploy --guided \
  --stack-name aegisweb-memory \
  --parameter-overrides StageName=prod \
    AllowedOrigin='https://your-dashboard.example' \
    ApiToken='long-random-shared-secret'
```

`ApiToken` is `NoEcho`, so CloudFormation will not display it. The agent sends it
as `Authorization: Bearer <token>` from `AEGIS_CLOUD_TOKEN`.

## Wire it into AegisWeb

Copy the `RunsEndpoint` output and add it to `.env`:

```bash
AEGIS_CLOUD_URL=https://abc123.execute-api.us-east-1.amazonaws.com/prod/runs
AEGIS_CLOUD_TOKEN=              # only if ApiToken is set
```

Then run the normal demo:

```bash
python -m aegisweb demo --headless
```

The trace gains `Cloud memory synced` and `run.json` gains a `cloud_sync` field.
If the network or AWS is unavailable, the run still succeeds; the trace reports
`Cloud memory unavailable` instead.

## Verify with curl

```bash
API=https://abc123.execute-api.us-east-1.amazonaws.com/prod

curl -s "$API/health" | jq

curl -s -X POST "$API/runs" \
  -H 'content-type: application/json' \
  -d '{
    "runId": "demo-curl-001",
    "task": "Capture the first product price",
    "status": "complete",
    "price": "$149.00",
    "product": "Ridgeline Field Lantern",
    "trackersBlocked": 3,
    "tabs": 2,
    "result": {"form_submitted": true, "duration_seconds": 8.4}
  }' | jq

curl -s "$API/runs/demo-curl-001" | jq
curl -s "$API/runs" | jq '.count, .runs[0]'
```

## API contract

`POST /runs`

```json
{
  "runId": "20261124-120000",
  "task": "Navigate to the demo storefront ...",
  "status": "complete",
  "price": "$149.00",
  "product": "Ridgeline Field Lantern",
  "trackersBlocked": 3,
  "tabs": 2,
  "createdAt": "2026-11-24T20:00:00+00:00",
  "result": {"success": true, "form_submitted": true, "duration_seconds": 8.4}
}
```

Responses: `201 {"ok":true,"runId":"..."}`, `400` for malformed input, `401` when
a token is configured and missing, `500` for infrastructure failures.

`GET /runs/{runId}` returns `{"ok":true,"run":{...}}` or `404`.
`GET /runs` returns the 25 newest records by `createdAt`.

## Cost and cleanup

With PAY_PER_REQUEST and a 256 MB Lambda, the demo stays inside the AWS free tier
for normal use. To remove everything:

```bash
aws cloudformation delete-stack --stack-name aegisweb-memory
```

DynamoDB point-in-time recovery is intentionally disabled to keep the demo cheap.

## Security notes

- DynamoDB is encrypted at rest with an AWS-owned key; the Lambda has CRUD access
  scoped to this one table.
- Deployments default to `AllowedOrigin=*` for local-demo convenience. Set a real
  origin and a non-empty `ApiToken` before exposing the endpoint publicly.
- The demo never posts browsing history, credentials, or form contents to AWS.
  Only the run summary shown above is synced.
- The local JSON memory remains authoritative; AWS is an optional mirror.
