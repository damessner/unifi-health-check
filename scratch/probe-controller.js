const https = require('https');
const config = require('../config');

const opts = {
  host: config.unifi.host,
  port: config.unifi.port,
  rejectUnauthorized: false,
};

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request({ ...opts, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 400) }));
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  console.log('Probing controller at', config.unifi.host + ':' + config.unifi.port);
  console.log('');

  const paths = [
    '/api/login',
    '/api/s/default/stat/device',
    '/api/s/default/stat/sta',
    '/api/self',
    '/api/s/default',
    '/proxy/network/api/s/default/stat/device',
    '/proxy/network/api/s/default/stat/sta',
    '/proxy/network/api/s/default',
    '/api/s/default/rest/device',
  ];

  for (const path of paths) {
    const r = await req(path);
    const snippet = r.body.replace(/\n/g, ' ').trim().slice(0, 200);
    console.log(`GET ${path} → ${r.status} ${snippet}`);
  }
})().catch((e) => console.error('Error:', e.message));
