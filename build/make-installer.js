// Turns dist/win-unpacked into dist/Donation-Desk-Setup-<version>.exe using NSIS.
// Needs `makensis` (NSIS) installed: on Windows from nsis.sourceforge.io,
// on Linux `apt install nsis`, on Mac `brew install makensis`.
const { execFileSync } = require('child_process');
const path = require('path');
const { version } = require('../package.json');
execFileSync('makensis', [`-DVERSION=${version}`, path.join(__dirname, 'installer.nsi')], { stdio: 'inherit' });
console.log(`\nInstaller ready: dist/Donation-Desk-Setup-${version}.exe`);
