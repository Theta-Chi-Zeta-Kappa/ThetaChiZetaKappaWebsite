window.TREE_CONFIG = {
  // Accepts either a normal Google Sheets share URL or a Publish to web URL.
  // For a public GitHub Pages deployment, publishing only the Database sheet
  // limits the public source to the records used by the family tree.
  googleSheetUrl: 'https://docs.google.com/spreadsheets/d/1OQZ1LaERaRQmHPm-gYRlGqlgxkkQAaQfN9ThpG9ZFRA/edit?usp=sharing',

  // Optional direct published CSV URL. Leave googleSheetUrl blank when using it.
  googleCsvUrl: '',

  fallbackWorkbookUrl: './Zeta_Kappa_Family_Tree_Database_Reconstructed.xlsx',
  sheetName: 'Database'
};
