require('dotenv').config();
const client = require('./services/unifiClient');

async function test() {
  try {
    const devices = await client.getDevices();
    console.log("Total devices:", devices.length);
    if (devices.length > 0) {
      console.log("\n--- Device properties ---");
      devices.forEach(d => {
        console.log(`MAC: ${d.mac} | Name: ${d.name} | Hostname: ${d.hostname} | Model: ${d.model} | Type: ${d.type}`);
      });
    } else {
      console.log("No devices found.");
    }
  } catch (err) {
    console.error("Error fetching devices:", err);
  }
}

test();
