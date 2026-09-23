const assert = require('assert');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

async function run() {
  console.log('Testing App Update Endpoints...');
  const app = express();
  app.use(express.json());

  // Mount chat routes
  const mountChat = require('../backend/chat');
  mountChat(app, {
    authRequired: (req, res, next) => { req.user = { id: 1, role: 'admin' }; next(); },
    requireRole: () => (req, res, next) => next(),
    logAction: () => {},
    signChat: () => 'fake_token'
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`Test server running on port ${port}`);

  // Test 1: GET /api/chat/app/version
  const verRes = await fetch(`http://127.0.0.1:${port}/api/chat/app/version`);
  assert.strictEqual(verRes.status, 200, 'version endpoint status 200');
  const verData = await verRes.json();
  console.log('Version response:', verData);
  assert.strictEqual(verData.latestVersion, '2.0.0', 'latestVersion should be 2.0.0');
  assert.strictEqual(verData.versionCode, 2, 'versionCode should be 2');
  assert.ok(verData.apkSize > 50000, 'apkSize should be > 50KB');
  assert.strictEqual(verData.downloadUrl, '/api/chat/app/download', 'downloadUrl is correct');

  // Test 2: GET /api/chat/app/download
  const dlRes = await fetch(`http://127.0.0.1:${port}/api/chat/app/download`);
  assert.strictEqual(dlRes.status, 200, 'download endpoint status 200');
  assert.strictEqual(dlRes.headers.get('content-type'), 'application/vnd.android.package-archive', 'Content-Type should be APK');
  const arrayBuffer = await dlRes.arrayBuffer();
  console.log('Downloaded APK bytes:', arrayBuffer.byteLength);
  assert.strictEqual(arrayBuffer.byteLength, verData.apkSize, 'Downloaded APK matches reported file size');

  server.close();
  console.log('✅ ALL APP UPDATE ENDPOINT TESTS PASSED!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
