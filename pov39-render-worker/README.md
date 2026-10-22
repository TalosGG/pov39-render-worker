# POV39 Rendering Worker

A separate Docker service that renders validated POV39 timelines into H.264/AAC MP4 files with FFmpeg. The Base44 `mediaPipeline` function calls it; customers never talk to it directly.

## What it does

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness only: returns `{ ok: true }` and nothing else |
| `GET /health/deep` | Bearer | Checks the database, storage and FFmpeg |
| `POST /jobs` | Bearer | Queues a job. `Idempotency-Key` header: a repeat returns the same job (`200`, `idempotent_replay: true`) |
| `GET /jobs/:id` | Bearer | Status, real progress (0–1), validation report and a short-lived signed output URL |
| `POST /jobs/:id/cancel` | Bearer | Cancels the job and stops FFmpeg if it is running |

Supported operations: `render_preview` (≤720p long side, fast), `render_master` (full resolution, CRF 18), `validate` (render plus a full validation report). Analysis operations (`transcribe`, `scene_detect`, …) return `422 unsupported_operation` until they are implemented.

Each job goes through these steps:

1. It downloads the source files over HTTPS only, from allowlisted hosts, with a size cap.
2. It copies the sources to private storage (`sources/<job>/<asset>`).
3. It renders the timeline: trims, speed, scale and letterbox to the output size, fades, black gaps, and optional burned subtitles in Hebrew or English.
4. It validates the output: MP4 container, H.264, yuv420p, AAC, exact dimensions, duration within 2%, faststart, and a full clean decode.
5. It uploads the result to `renders/<job>/output.mp4`.

A file that fails validation is never uploaded, and the job is marked `failed` with the report attached.

Jobs are stored in Postgres. If the process crashes, any running job is put back in the queue (up to 3 attempts). Signed source URLs are never returned, and errors never contain URLs.

## Infrastructure you need

1. **Render.com web service** (Docker, *Standard* plan or higher: rendering needs at least 2 GB RAM). Keep it at **1 instance**, because crash recovery assumes a single worker process.
2. **Render Postgres** for the job store. The included `render.yaml` creates it.
3. **A private S3-compatible bucket.** Cloudflare R2 is recommended; AWS S3 also works. Block all public access. Create an API key that can read and write this bucket only.

## Environment variables

| Name | Value |
|---|---|
| `VIDEO_PROCESSING_TOKEN` | At least 32 random characters, e.g. `openssl rand -hex 32`. Use the **same value** in Base44 Secrets |
| `DATABASE_URL` | Set automatically from the Render Postgres database |
| `S3_BUCKET` | Bucket name |
| `S3_ENDPOINT` | R2: `https://<account-id>.r2.cloudflarestorage.com`. Leave empty for AWS |
| `S3_REGION` | `auto` for R2, e.g. `eu-central-1` for AWS |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Bucket-scoped key |
| `ALLOWED_SOURCE_HOSTS` | Comma-separated hosts Base44 signed URLs come from (e.g. `base44.app,supabase.co`) |
| `RENDER_CONCURRENCY` | `1` (raise it only on larger instances) |
| `MAX_SOURCE_BYTES` | Default 2 GB |
| `DOWNLOAD_URL_TTL_SECONDS` | Signed output URL lifetime, default 900 |

## Deploy on Render.com

1. Put the `worker/` folder in a Git repository, and copy `render.yaml` to the **repository root**.
2. In Render, go to **New → Blueprint**, select the repository, and fill in the variables marked `sync: false`.
3. Wait for the deploy, then check the service:
   - `curl https://<service>.onrender.com/health` should return `{"ok":true}`.
   - `curl -H "Authorization: Bearer $TOKEN" https://<service>.onrender.com/health/deep` should report the database and storage as `true` and show the FFmpeg version.
4. Test the engine inside the image: `docker build -t pov39-render-worker worker && docker run --rm pov39-render-worker npm run selftest`. It exits with code 0 and prints a passing validation report.
5. Only then, set these in Base44 Secrets: `VIDEO_PROCESSING_URL=https://<service>.onrender.com` and `VIDEO_PROCESSING_TOKEN` (the same value as on the worker).
6. Run a real end-to-end render from POV39 using an uploaded clip. Rendering counts as connected only after that render succeeds and passes validation.

## Example job

```http
POST /jobs
Authorization: Bearer <token>
Idempotency-Key: <RenderJobs record id>

{ "operation": "render_master",
  "inputs": { "timeline": { "tracks": [...], "subtitles": {...}, "output": {...} },
              "sources": { "<asset_id>": "https://…signed…" } },
  "output_spec": { "width": 1080, "height": 1920, "fps": 30 } }
``