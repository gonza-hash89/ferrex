const fs = require('fs');
const path = require('path');

const apiUrl = process.env.VITE_API_URL || 'https://ferrex-api.onrender.com';
const indexPath = path.join(__dirname, 'frontend', 'index.html');

let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('"__VITE_API_URL__"', `"${apiUrl}"`);
fs.writeFileSync(indexPath, html);

console.log(`Injected API URL: ${apiUrl}`);