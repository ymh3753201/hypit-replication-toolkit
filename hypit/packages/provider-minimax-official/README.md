
## Optional business submission policy (2026-09-30)

The paired business workspace enables `submissionPolicyModule`, `submissionPlan`, and `submissionLedgerRoot` together. Before POST, the policy receives the compiled official body, actual reference-byte fingerprints, the real `need.id` source identity and the Runtime `operation` ID. It reserves a shared grant, persists known task receipts independently of checkpoints, and resumes known tasks without another POST. Unknown submissions stay reserved. Collected bytes are recorded as `generated_unreviewed`, never human acceptance. Policy metadata is not sent to MiniMax. Profiles without this optional policy retain existing compatibility.

This is implemented in this local Provider, not Hypit core. The policy and its business tests live in the outer workspace; the checkout must remain at `<workspace>/hypit` for the paired test suite. Run `../bin/test-replication` from this checkout, or follow the outer `docs/复刻优化使用说明.md`. No live smoke test is part of that command.

## Local-first H3 references (2026-10-03)

`assetTransport` defaults to `auto`. Images, MP4 and WAV/MP3 are passed as documented Base64 data URIs. If the complete JSON exceeds 64MB, the largest inline assets are uploaded through `/v1/files/upload` with `purpose=video_generation_input`, then referenced by `mm_file://<id>`. MOV uses this file interface directly. No OSS credentials, SDK, bucket or customer-hosted URL are required. Uploaded bytes and ordered reference roles remain unchanged. Explicit `inline` rejects an oversized request before a video POST; `platform` uses model-account files; `oss` opts into the previous private-OSS bridge. Only explicit `oss` diagnoses the OSS environment.

Platform file IDs are recorded alongside the receipt. They are retained while work is pending or submission is unknown. After a definitive outcome the adapter attempts deletion; any cleanup failure is reported (official input files expire after seven days). API failure never switches to OSS or creates another generation request. Requests are size-checked before the protected submission policy; inline media is excluded from error text and ledger summaries.

Official references: https://platform.minimax.cn/docs/api-reference/video-generation-v2-create and https://platform.minimax.cn/docs/api-reference/file-management-upload.

Observed H3 output timing may drift slightly from integer requested seconds. The provider and paired business output registrar accept at most 0.5 seconds of drift, preserve original bytes, and still reject larger errors. Measured duration and official usage remain distinct.
