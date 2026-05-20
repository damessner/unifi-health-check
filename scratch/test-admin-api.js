const { spawn } = require('child_process');
const http = require('http');

const TEST_PORT = 3999;
let serverProcess = null;
let cookie = '';

// Helper to make HTTP requests
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    if (cookie) {
      reqHeaders['Cookie'] = cookie;
    }
    
    const req = http.request({
      host: '127.0.0.1',
      port: TEST_PORT,
      path: path,
      method: method,
      headers: reqHeaders
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        // Capture Set-Cookie if present
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          cookie = setCookie[0].split(';')[0];
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: responseBody ? JSON.parse(responseBody) : {}
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting Admin API Integration Tests ---');
  
  // 1. Check Auth Status (Unauthenticated)
  try {
    const res = await request('GET', '/api/auth/status');
    console.log('1. Auth Status (Unauthenticated):', res.status === 200 && res.body.authenticated === false ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 1 failed:', e);
  }

  // 2. Attempt Channel Change Without Session
  try {
    const res = await request('POST', '/api/admin/change-channel', {
      apMac: '24:5a:4c:11:22:33',
      radio: 'na',
      channel: 36
    });
    console.log('2. Channel Change (No Session):', res.status === 401 ? 'PASS' : 'FAIL', res.status);
  } catch (e) {
    console.error('Test 2 failed:', e);
  }

  // 3. Login with Invalid Credentials
  try {
    const res = await request('POST', '/api/auth/login', {
      username: 'admin',
      password: 'wrongpassword'
    });
    console.log('3. Login (Invalid Creds):', res.status === 401 ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 3 failed:', e);
  }

  // 4. Login with Valid Credentials
  try {
    const res = await request('POST', '/api/auth/login', {
      username: 'admin',
      password: 'admin'
    });
    console.log('4. Login (Valid Creds):', res.status === 200 && res.body.success === true ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 4 failed:', e);
  }

  // 5. Check Auth Status (Authenticated)
  try {
    const res = await request('GET', '/api/auth/status');
    console.log('5. Auth Status (Authenticated):', res.status === 200 && res.body.authenticated === true ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 5 failed:', e);
  }

  // 6. Channel Change (Invalid MAC Format)
  try {
    const res = await request('POST', '/api/admin/change-channel', {
      apMac: 'invalid-mac',
      radio: 'na',
      channel: 36
    });
    console.log('6. Channel Change (Invalid MAC):', res.status === 400 ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 6 failed:', e);
  }

  // 7. Channel Change (Invalid Radio Band)
  try {
    const res = await request('POST', '/api/admin/change-channel', {
      apMac: '24:5a:4c:11:22:33',
      radio: 'invalid-band',
      channel: 36
    });
    console.log('7. Channel Change (Invalid Radio):', res.status === 400 ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 7 failed:', e);
  }

  // 8. Channel Change (Invalid Channel Number)
  try {
    const res = await request('POST', '/api/admin/change-channel', {
      apMac: '24:5a:4c:11:22:33',
      radio: 'na',
      channel: -5
    });
    console.log('8. Channel Change (Invalid Channel):', res.status === 400 ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 8 failed:', e);
  }

  // 9. Channel Change (Valid Request)
  try {
    const res = await request('POST', '/api/admin/change-channel', {
      apMac: '02:00:00:00:00:01', // Fits one of the Mock AP MACs
      radio: 'na',
      channel: 44
    });
    console.log('9. Channel Change (Valid Request):', res.status === 200 && res.body.success === true ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 9 failed:', e);
  }

  // 10. Admin Logout
  try {
    const res = await request('POST', '/api/auth/logout');
    console.log('10. Admin Logout:', res.status === 200 && res.body.success === true ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 10 failed:', e);
  }

  // 11. Check Auth Status (After Logout)
  try {
    const res = await request('GET', '/api/auth/status');
    console.log('11. Auth Status (After Logout):', res.status === 200 && res.body.authenticated === false ? 'PASS' : 'FAIL', res.body);
  } catch (e) {
    console.error('Test 11 failed:', e);
  }
}

// Start test server process
console.log('Starting test server...');
serverProcess = spawn('node', ['server.js'], {
  env: {
    ...process.env,
    PORT: TEST_PORT,
    MOCK_MODE: 'true',
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'admin'
  }
});

serverProcess.stdout.on('data', (data) => {
  // Suppress output unless server started
  if (data.toString().includes('dashboard is running')) {
    setTimeout(async () => {
      try {
        await runTests();
      } catch (err) {
        console.error(err);
      } finally {
        console.log('Stopping test server...');
        serverProcess.kill();
        process.exit(0);
      }
    }, 500);
  }
});

serverProcess.stderr.on('data', (data) => {
  console.error('Server error:', data.toString());
});
