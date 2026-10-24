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

Supported operations: `render_preview` (≤720p long side, fast), `render_master` (full resolution, CRF 18), `render_motion` (motion graphics rendered from a composition, no source footage), `validate` (render plus a full validation report). Capability report: `GET /capabilities` (Bearer) answers what this build can actually do — see below. Analysis operations (`transcribe`, `scene_detect`, …) return `422 unsupported_operation` until they are implemented.

Each job goes through these steps:

1. It downloads the source files over HTTPS only, from allowlisted hosts, with a size cap.
2. It copies the sources to private storage (`sources/<job>/<asset>`).
3. It renders the timeline: trims, speed, scale and letterbox to the output size, fades, black gaps, and optional burned subtitles in Hebrew or English.
4. It validates the output: MP4 container, H.264, yuv420p, AAC, exact dimensions, duration within 2%, faststart, and a full clean decode.
5. It uploads the result to `renders/<job>/output.mp4`.

A file that fails validation is never uploaded, and the job is marked `failed` with the report attached.

## Capability reporting

Editing footage and rendering motion graphics are separate capabilities, and the app must
never charge for a job this build cannot perform. `GET /capabilities` (Bearer) answers:

```json
{ "version": "1.1.0",
  "operations": ["render_master", "render_motion", "render_preview", "validate"],
  "motion": { "ready": true, "chromium_path": "/usr/bin/chromium",
              "chromium": "Chromium 120.0.6099.224", "project": true, "remotion": "^4.0.538", "reason": "" } }
```

`motion.ready` is true only when this image really has the motion project *and* a browser
that starts. `reason` says which of the two is missing. `/health/deep` reports the same
values as `version`, `operations`, `motion_ready` and `motion`, and stays healthy on a
worker that renders footage but has no browser.

## Motion graphics (create from scratch)

`render_motion` renders a **motion composition** instead of a cut timeline: no source files and no FFmpeg filtergraph. The composition — brand colours, copy and scene list — arrives as data and is rendered with Remotion from `worker/remotion`, using the Chromium installed in this image (`REMOTION_CHROME_PATH`, default `/usr/bin/chromium`).

* The contract and its clamps live in `remotion/src/format.js`; the app-side builder is `base44/shared/motion.ts`, and the worker re-validates every value before rendering (`src/render/motion.js`). Only validated composition data is accepted: no generated code and no shell commands are ever executed.
* The file is checked twice: the standard validation above, plus `remotion/scripts/verify-motion.mjs`, which samples real frames and proves they change over time.
* The result is stored under the same key as any other render (`renders/<job>/output.mp4`), so playback uses the existing signed storage route.
* `inputs.composition` is required and size-capped at 200 KB; `inputs.sources` is not used.
* Without Chromium in the image, the worker falls back to a self-contained browser it unpacks for itself (`remotion/scripts/local-chromium.mjs`), which is slower on start but needs no system packages.

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
| `RENDER_CONCURRENCY` | `1` (raise it only on larger instances; never above 2) |
| `REMOTION_CONCURRENCY` | Frames the motion renderer draws at once. Default: half the cores, at most 2 — an extra browser tab costs hundreds of MB |
| `MOTION_MIN_MEMORY_MB` | `1024`. A motion job is refused, quoting the instance's measured memory, when the container cannot hold a browser |
| `MAX_SOURCE_BYTES` | Default 2 GB |
| `DOWNLOAD_URL_TTL_SECONDS` | Signed output URL lifetime, default 900 |

## Deploy on Render.com

1. Put the `worker/` folder in a Git repository, and copy `render.yaml` to the **repository root**.
2. In Render, go to **New → Blueprint**, select the repository, and fill in the variables marked `sync: false`.
3. Wait for the deploy, then check the service:
   - `curl https://<service>.onrender.com/health` should return `{"ok":true}`.
   - `curl -H "Authorization: Bearer $TOKEN" https://<service>.onrender.com/health/deep` should report the database and storage as `true`, show the FFmpeg version, and report `resources` (the container's measured memory limit and use), `motion_concurrency` and `active_jobs`.

   If a render is interrupted, the evidence is on the job row — `diagnostics` (exit code, signal, kill reason, peak RSS of the whole render process group) and `interruptions` — and in the log: the `[boot]` line prints the instance's memory ceiling, and `[motion] render process group rss=…` prints the render's memory every 30 seconds. Together they separate a host kill from a bad render; `/health` (the light probe) is what the platform's health check must point at, so a busy renderer is never judged unhealthy for being busy.
4. Test the engine inside the image: `docker build -t pov39-render-worker worker && docker run --rm pov39-render-worker npm run selftest`. It exits with code 0 and prints a passing validation report.
5. Only then, set these in Base44 Secrets: `VIDEO_PROCESSING_URL=https://<service>.onrender.com` and `VIDEO_PROCESSING_TOKEN` (the same value as on the worker).
6. Run a real end-to-end render from POV39 using an uploaded clip. Rendering counts as connected only after that render succeeds and passes validation.

## Replacing the running service

The live service is `pov39-render-worker` on Render, described by `worker/render.yaml`.
Motion graphics only work on a build that carries the Remotion project and a browser, so an
older deployment has to be replaced rather than patched:

1. Commit the `worker/` folder and push the branch Render deploys from.
2. In Render, open the service and choose **Manual Deploy → Deploy latest commit** (or let
   auto-deploy pick the push up).
3. Let the build finish. The first build after this change installs Chromium and the
   Remotion dependencies, so it takes several minutes and needs the Standard plan.
4. Confirm the new build reports itself honestly:
   `curl -H "Authorization: Bearer $TOKEN" https://pov39-render-worker.onrender.com/capabilities`
   It must answer `"version": "1.1.0"`, list `render_motion`, and set
   `"ready": true` under `motion`.
5. Only then use **Create from scratch** in POV39. Until that check passes, POV39 refuses
   the job before charging anything, and says why.

A worker that only edits footage stays perfectly valid for every editing flow; the
capability check exists so the two are never confused.

## Example job

```http
POST /jobs
Authorization: Bearer <token>
Idempotency-Key: <RenderJobs record id>

{ "operation": "render_master",
  "inputs": { "timeline": { "tracks": [...], "subtitles": {...}, "output": {...} },
              "sources": { "<asset_id>": "https://…signed…" } },
  "output_spec": { "width": 1080, "height": 1920, "fps": 30 } }
