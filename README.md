# Zeta Kappa Family Tree — Website-Integrated v13

This package integrates the Version 11 live family-tree viewer with the published Zeta Kappa website header and hamburger navigation.

Version 13 explicitly centers the member-details dialog and removes all visitor-facing data reload controls. The page performs one automatic live-data request when it loads. Visitors cannot manually select a workbook, enter another database URL, or trigger repeated refreshes from the interface.

## Install

Place these files in the same website directory as `HomePage.html` and `styleHomePage.css`:

- `FamilyTreeCannon.html`
- `styleFamilyTree.css`
- `familyTreeApp.js`
- `familyTreeConfig.js`
- `Zeta_Kappa_Family_Tree_Database_Reconstructed.xlsx`

An unchanged copy of the published `styleHomePage.css` is included so the package can be reviewed as a complete set. If the website already contains that exact stylesheet, it does not need to be replaced.

The family-tree page reuses the website's existing assets:

- `styleHomePage.css`
- `path-10.svg`
- `path-20.svg`
- `path-30.svg`
- `img/_248-zeta-kappa-ohio-northern-pdf-10.png`

Keeping the filename `FamilyTreeCannon.html` means the current homepage and sidebar links continue to work without changes.

## Styling architecture

The page loads `styleHomePage.css` first for the shared website header, followed by `styleFamilyTree.css`. All family-tree application styles are scoped beneath `.family-tree-page`, preventing the tree from changing the website header or navigation.

## Live data

The Google Sheets URL remains configured in `familyTreeConfig.js`. It may be either a normal viewer-sharing URL or a Google Sheets **Publish to web** URL. A published CSV URL can instead be placed in `googleCsvUrl` when `googleSheetUrl` is left blank.

For the narrowest public exposure, publish only the `Database` sheet rather than the entire workbook. The bundled workbook is retained as an automatic fallback, but there is no manual workbook picker.

Published-page example:

```js
googleSheetUrl: 'https://docs.google.com/spreadsheets/d/e/PUBLISHED_ID/pubhtml?gid=DATABASE_GID&single=true',
googleCsvUrl: '',
```

Published-CSV example:

```js
googleSheetUrl: '',
googleCsvUrl: 'https://docs.google.com/spreadsheets/d/e/PUBLISHED_ID/pub?output=csv&gid=DATABASE_GID',
```

Leave automatic republishing enabled in Google Sheets if website visitors should receive later database edits automatically when they next open the page.

## Preserved Version 11 behavior

- Ordered family selection
- Ranked name and roster-number search
- Live Google Sheets refresh and Excel fallback
- Desktop pan, zoom, and fit controls
- Lineage and descendant views
- Double-click member details on desktop
- Responsive mobile family list
- Hidden Unique IDs outside member details
- Founding Father visual treatment
