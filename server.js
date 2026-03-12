const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 10000;
// すべてのファイルが入っている public フォルダをルートにする
const root = path.join(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^\.\.(\/|\\|$)/, '');
  let filePath = path.join(root, safePath === '/' ? '/index.html' : safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // ファイルがない場合は index.html に飛ばす (SPA対応)
      fs.readFile(path.join(root, 'index.html'), (err2, data2) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});