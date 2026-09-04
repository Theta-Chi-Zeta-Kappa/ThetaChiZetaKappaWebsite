window.TREE_CONFIG = {
  // Accepts either a normal Google Sheets share URL or a Publish to web URL.
  // For a public GitHub Pages deployment, publishing only the Database sheet
  // limits the public source to the records used by the family tree.
  googleSheetUrl: '',

  // Optional direct published CSV URL. Leave googleSheetUrl blank when using it.
  googleCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRoJV8IlXi5p5A3MG6-bqn5ngwSGDwoA3z2LaBNlizzjR29SJRjsBSHirmSX7eLRdIs7bxMr39i5y0A/pub?gid=517679212&single=true&output=csv',

  fallbackWorkbookUrl: './Zeta_Kappa_Family_Tree_Database_Reconstructed.xlsx',
  sheetName: 'Database'
};
