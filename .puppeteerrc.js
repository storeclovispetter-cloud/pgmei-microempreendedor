const path = require('path');

module.exports = {
    // Cache dentro da pasta do projeto (persistente no build)
    cacheDirectory: path.join(__dirname, '.cache', 'puppeteer')
};