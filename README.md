# Theta Chi — Zeta Kappa Website

Production website and Admin Portal for the Zeta Kappa Chapter of Theta Chi Fraternity at Ohio Northern University.

## Architecture
The public website is static and uses clean directory URLs. Dynamic Gallery, Blog, Newsletter, account, approval, and Admin functionality is provided by the deployed `tczk-admin-api` Cloudflare Worker. D1 stores metadata and workflow state. Gallery media uses the Gallery R2 bucket; publication PDFs and covers use `zk-publications` through the `Publications` Worker binding.

Blog and Newsletter public pages are CMS-only. The Family Tree intentionally continues to use its Google Sheets data source.

## Main directories
- `/admin/` — authenticated Admin/Editor portal
- `/blog/` — Blog landing page and shared Blog PDF viewer
- `/newsletter/` — Newsletter landing page and Newsletter PDF viewer
- `/gallery/` — public gallery
- `/family-tree/` — family tree viewer
- `/sponsors/` — sponsors page
- `/assets/`, `/css/`, `/js/`, `/data/` — production resources

## Content behavior
`Featured` may be applied to either Blog posts or Newsletters. `Current Newsletter` is separate, applies only to Newsletters, and controls the main issue shown on `/newsletter/`. Only one published Newsletter can be Current Newsletter at a time.

Admins may edit published publication metadata. Published PDF and cover objects remain immutable/versioned; replacing a published file requires a dedicated replacement workflow rather than overwriting the existing R2 object.

## Gallery tools
The Admin Gallery upload page provides the current batch processor from `/assets/tools/Gallery-v3-Batch-Processor.zip`. The gallery recovery seed is intentionally stored with the separate backend/deployment archive rather than in the public website repo.

## Backend
Cloudflare Worker source and D1 migrations are intentionally not stored in this public website repository. Keep the separate backend/deployment archive as the recovery and deployment source of truth.

## Deployment notes
This production copy does not include the local `serve-local.bat` helper. Production Cloudflare CORS should allow only `https://www.tczk.org` and `https://tczk.org`.
