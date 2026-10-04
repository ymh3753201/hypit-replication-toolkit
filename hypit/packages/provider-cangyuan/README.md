# Cangyuan provider (project-local)

An asynchronous Seedance 2.0 provider for the existing Cangyuan relay. Verified contract date: 2026-09-27. Supports the two existing configured model IDs only: `sd12-seedance-2.0` (480p, output + references <= 18s) and `sd14-seedance-2.0` (720p, <= 25s). No Seedance 2.5 or Ark fallback. An empty fallback list pins a single model.

Requests use POST `/v1/videos`, polling GET `/v1/videos/{id}`, and the HTTPS result URL. First/last frames map to `first_image_url` / `last_image_url`. Unknown wire parameters are not sent. Model selection respects resolution, audio support and reference-duration budgets. SD14 requires `generate-audio=false`; its undocumented native audio is removed from the collected output. Use local composition for retained/source audio.

References are probed before upload and video is normalized to H.264/yuv420p MP4 with faststart and a supported frame rate. Small otherwise-valid video is scaled proportionally to at least 407696 pixels (SD14 live-service requirement). Invalid/too-long references are rejected before billing, never silently trimmed. Local files use the existing private AI Dsp OSS transport, with random short keys and signed HTTPS URLs. API keys and signed URLs are redacted from errors. The existing external Python environment/storage module remains required, configurable through `ossPython` and `ossStorageModule`; no duplicate credentials or public bucket are created.

Only a definitive model-identity rejection permits trying another compatible configured model. A receipt is checkpointed before polling. Transient polling network/429/5xx errors query the same task. Uncertain POST responses must be reconciled at the service, not resubmitted. Reference assets are not deleted while the outcome is uncertain; existing bucket lifecycle is the backstop. Cleanup failures do not invalidate an otherwise valid downloaded video.

Ordinary tests (no billing):

```sh
node --import tsx --test packages/provider-cangyuan/test/*.test.ts
```

Explicit paid smoke test, isolated output directory, optional single configured model ID:

```sh
node --import tsx packages/provider-cangyuan/scripts/smoke.ts --live ../audits/your-run sd14-seedance-2.0
```

The smoke runner uses new synthetic reference video + character image. A directory records submission markers/receipts; rerunning resumes or skips terminal tasks, never silently rebills them. Private checkpoints may contain temporary signed result URLs and must not be published. Test success proves that particular endpoint/media combination, not guaranteed success for all creative requests.
