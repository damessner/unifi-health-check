const https = require('https');

const host = '172.16.0.200';
const port = 8443;
const username = 'observer';
const password = '3^K@nP:!$@Hc;,P';
const site = 'default';

const agent = new https.Agent({
  rejectUnauthorized: false
});

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    const req = https.request({
      host,
      port,
      agent,
      path: options.path,
      method: options.method || 'GET',
      headers: headers
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function run() {
  const loginRes = await request({
    method: 'POST',
    path: '/api/login'
  }, {
    username,
    password,
    remember: true
  });

  if (loginRes.statusCode !== 200) {
    console.error('Login failed:', loginRes.body);
    return;
  }

  const cookies = loginRes.headers['set-cookie'] || [];
  const unifisesCookie = cookies.find(c => c.startsWith('unifises='));
  if (!unifisesCookie) {
    console.error('No cookie received.');
    return;
  }

  const cookie = unifisesCookie.split(';')[0];

  const clientRes = await request({
    method: 'GET',
    path: `/api/s/${site}/stat/sta`,
    headers: { 'Cookie': cookie }
  });

  if (clientRes.statusCode !== 200) {
    console.error('Fetch clients failed:', clientRes.body);
    return;
  }

  const data = JSON.parse(clientRes.body);
  const clients = data.data || [];

  console.log(`Fetched ${clients.length} active client devices.`);
  if (clients.length === 0) return;

  // Let's print out keys of the first client to see what properties exist
  const firstClient = clients[0];
  console.log('\nKeys on client object:', Object.keys(firstClient));

  // Let's print 5 sample clients with interesting metrics
  console.log('\nSample Clients telemetry fields:');
  clients.slice(0, 10).forEach((c, idx) => {
    console.log(`\n[Client #${idx + 1}] Hostname: "${c.hostname || c.name || 'N/A'}"`);
    console.log(`- IP: "${c.ip || 'N/A'}"`);
    console.log(`- MAC: "${c.mac}"`);
    console.log(`- OUI: "${c.oui || 'N/A'}"`);
    console.log(`- RSSI/Signal: ${c.signal || 'N/A'} dBm`);
    console.log(`- Satisfaction/Experience: ${c.satisfaction || c.experience_score || 'N/A'}%`);
    console.log(`- TX Rate: ${c.tx_rate || 'N/A'} Kbps`);
    console.log(`- RX Rate: ${c.rx_rate || 'N/A'} Kbps`);
    console.log(`- TX Bytes: ${c.tx_bytes || 'N/A'} Bytes`);
    console.log(`- RX Bytes: ${c.rx_bytes || 'N/A'} Bytes`);
    console.log(`- WiFi Retries Pct: ${c.wifi_tx_retries_percentage || 'N/A'}%`);
    
    // Check if there are disconnect, roam, or reconnect counters
    console.log(`- roam_count: ${c.roam_count !== undefined ? c.roam_count : 'N/A'}`);
    console.log(`- disconnects: ${c.disconnects !== undefined ? c.disconnects : 'N/A'}`);
    console.log(`- reconnects: ${c.reconnects !== undefined ? c.reconnects : 'N/A'}`);
    console.log(`- assoc_time: ${c.assoc_time || 'N/A'} (seconds connected)`);
    console.log(`- uptime: ${c.uptime || 'N/A'} (seconds uptime)`);
  });
}

run().catch(console.error);
