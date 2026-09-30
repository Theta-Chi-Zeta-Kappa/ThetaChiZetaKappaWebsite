# Chapter History Submission Backend — Phase 1

This checkpoint establishes the D1 schema and the R2 storage binding expected by the next Worker update.

## D1
Run `database/chapter-history-submissions.sql` against the existing TCZK D1 database.

The schema creates:
- `chapter_history_submissions`
- `chapter_history_submission_files`
- `chapter_history_deletion_audit`

Statuses: `new`, `reviewing`, `acted_upon`, `rejected`.

Only a minimal deletion audit survives permanent deletion. Contributor details, descriptions, and file contents are not copied into the audit table.

## R2
Create or reuse an R2 bucket for historical submissions and bind it to the admin API Worker as:

`HISTORY_UPLOADS`

Recommended bucket name:
`tczk-history-submissions`

Objects will use keys in this form in Phase 2:

`chapter-history/<submission-public-id>/<generated-file-id>-<safe-original-name>`

The original filename and file metadata belong in D1; object keys must not be based solely on an untrusted uploaded filename.

## Limits / allowlist planned for the Worker
Combined upload limit: 100 MB per submission.

Extensions:
ZIP, PDF, DOC/DOCX, TXT/RTF/MD, CSV/XLS/XLSX, PPT/PPTX, JPG/JPEG, PNG, WEBP.

The Worker must validate extension, size, and supplied content type. ZIP is accepted as an archive, but is never executed or automatically extracted by the public endpoint.

## Permissions planned for Phase 2
- Public: create a submission and upload its files.
- P2: list/read submissions, download files, add notes, change review status.
- P1: all P2 actions plus permanent deletion.
- Editors: no historical-submission access.
- Normal deletion: after `acted_upon`.
- P1 exception deletion: spam, duplicate, accidental submission, with an explicit reason.

Permanent deletion order:
1. enumerate the submission's D1 file rows;
2. delete each R2 object;
3. transactionally write the minimal deletion audit and remove D1 file/submission rows.

Do not expose raw R2 object URLs publicly. Downloads should pass through an authenticated admin Worker endpoint.
