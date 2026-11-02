# Theta Chi Zeta Kappa Website

Production website repository for Theta Chi Fraternity, Zeta Kappa Chapter at Ohio Northern University.

## Current architecture
- Static public/admin frontend: HTML, CSS, JavaScript
- Cloudflare Worker API: `backend/worker.js`
- Cloudflare D1 for structured data
- Cloudflare R2 for gallery/publication/history files
- Square for registration/payment checkout

## Forms and registrations
Reusable surveys and registrations are created in `/admin/forms/` and published through `/forms/?form=<slug>`. The previous dedicated interest-survey and Spring Formal pages have been retired.

## Local development
Run `server.bat` from this folder to serve the static site locally.

## Repository notes
- `backend/worker.js` is the single canonical Worker source retained in this repository.
- `database/` contains the current generalized forms-builder and chapter-history schema/migrations retained for maintenance/recovery.
- `assets/tools/Gallery-v3-Batch-Processor.zip` is intentionally retained because the Gallery Upload admin page links to it.
