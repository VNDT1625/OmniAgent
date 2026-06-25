const fs = require('fs');
const path = require('path');
const file = 'C:\\Users\\MyPC\\AppData\\Roaming\\npm\\node_modules\\agi\\package.json';
try {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync('C:\\NDT\\PJ\\AionUi\\test_out.txt', JSON.stringify(pkg, null, 2));
} catch (err) {
  fs.writeFileSync('C:\\NDT\\PJ\\AionUi\\test_out.txt', 'error: ' + err.stack);
}
