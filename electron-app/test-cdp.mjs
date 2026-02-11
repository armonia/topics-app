// Test CDP connection to Electron app
// Run this after starting the Electron app: npm start

const CDP_URL = 'http://127.0.0.1:19222';

async function testCDP() {
  console.log(`Testing CDP connection to ${CDP_URL}...`);
  
  try {
    // Test /json/version
    const versionResp = await fetch(`${CDP_URL}/json/version`);
    if (!versionResp.ok) {
      console.error('Failed to get version:', versionResp.status);
      return;
    }
    const version = await versionResp.json();
    console.log('Version:', JSON.stringify(version, null, 2));
    
    // Test /json/list
    const listResp = await fetch(`${CDP_URL}/json/list`);
    if (!listResp.ok) {
      console.error('Failed to list targets:', listResp.status);
      return;
    }
    const targets = await listResp.json();
    console.log('\nTargets:');
    for (const target of targets) {
      console.log(`  - ${target.id}: ${target.title || 'Untitled'}`);
      console.log(`    URL: ${target.url}`);
      console.log(`    WebSocket: ${target.webSocketDebuggerUrl}`);
    }
    
    console.log('\n✅ CDP connection successful!');
    console.log('\nTo use with OpenClaw browser tool, run:');
    console.log(`  openclaw browser --cdp-url=${CDP_URL} snapshot`);
    
  } catch (err) {
    console.error('❌ CDP connection failed:', err.message);
    console.log('\nMake sure the Electron app is running:');
    console.log('  cd ~/.openclaw/workspace/topics-app/electron-app && npm start');
  }
}

testCDP();
