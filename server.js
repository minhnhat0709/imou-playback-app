require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mqtt = require('mqtt');
const { createClient } = require('@supabase/supabase-js');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Load configurations from environment variables
const PORT = process.env.PORT || 3000;
const IMOU_APP_ID = process.env.IMOU_APP_ID;
const IMOU_APP_SECRET = process.env.IMOU_APP_SECRET;
const IMOU_DATA_CENTER = process.env.IMOU_DATA_CENTER || 'sg';
const CAMERA_TIMEZONE = process.env.CAMERA_TIMEZONE || 'Asia/Ho_Chi_Minh';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL_CUSTOM_DOMAIN = process.env.R2_PUBLIC_URL_CUSTOM_DOMAIN;

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'cmaphcm/cam-cut';

const CACHE_FILE = path.join(__dirname, 'token-cache.json');
const VIDEOS_DIR = path.join(__dirname, 'public', 'videos');
const TEMP_DIR = path.join(__dirname, 'temp_downloads');

// Initialize Express
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure directories exist
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Initialize Clients if configured
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[Supabase] Client initialized successfully.');
} else {
  console.warn('[Supabase] Warning: SUPABASE_URL and SUPABASE_KEY are not fully configured.');
}

let s3Client = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY
    }
  });
  console.log('[Cloudflare R2] S3 Client initialized successfully.');
} else {
  console.warn('[Cloudflare R2] Warning: Cloudflare R2 credentials are not fully configured.');
}

// Format date helper: YYYY-MM-DD HH:mm:ss in camera's specific timezone
function formatDate(date) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: CAMERA_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const getPart = type => parts.find(p => p.type === type).value;

    const yyyy = getPart('year');
    const mm = getPart('month');
    const dd = getPart('day');
    let hh = getPart('hour');
    if (hh === '24') hh = '00'; // Fix standard edge case
    const min = getPart('minute');
    const ss = getPart('second');

    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  } catch (err) {
    console.error('[Timezone Error] Fallback to server local time format:', err.message);
    const pad = num => String(num).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }
}

// Generate MD5 Sign for Imou OpenAPI
function generateSign(time, nonce, appSecret) {
  const signTemplate = `time:${time},nonce:${nonce},appSecret:${appSecret}`;
  return crypto.createHash('md5').update(signTemplate, 'utf8').digest('hex');
}

// Read and write cached tokens
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error("Failed to read token cache file:", err.message);
  }
  return { accessToken: null, accessTokenExpiresAt: 0, kitTokens: {} };
}

function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error("Failed to write token cache file:", err.message);
  }
}

// Wait for a file download to finish in a folder
async function waitForDownload(dir) {
  let file = null;
  const startTime = Date.now();
  while (Date.now() - startTime < 45000) { // 45 seconds timeout
    const files = fs.readdirSync(dir);
    const crdownload = files.find(f => f.endsWith('.crdownload'));
    const mp4 = files.find(f => f.endsWith('.mp4'));
    if (mp4 && !crdownload) {
      file = path.join(dir, mp4);
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return file;
}

// Keep only the 10 latest video files in public/videos folder
function cleanupOldVideos() {
  try {
    const files = fs.readdirSync(VIDEOS_DIR);
    const mp4Files = files
      .filter(file => file.endsWith('.mp4'))
      .map(file => {
        const filePath = path.join(VIDEOS_DIR, file);
        const stat = fs.statSync(filePath);
        return { name: file, path: filePath, mtime: stat.mtimeMs };
      });

    if (mp4Files.length > 10) {
      // Sort by modified time: oldest first
      mp4Files.sort((a, b) => a.mtime - b.mtime);
      const toDeleteCount = mp4Files.length - 10;
      for (let i = 0; i < toDeleteCount; i++) {
        console.log(`[Cleanup] Deleting old local video: ${mp4Files[i].path}`);
        fs.unlinkSync(mp4Files[i].path);
      }
    }
  } catch (err) {
    console.error('[Cleanup Error] Failed to rotate old videos:', err.message);
  }
}

// Get/Refresh Imou AccessToken & KitToken internally without loopback REST call
// Get or refresh Imou AccessToken
async function getAccessToken() {
  const dc = IMOU_DATA_CENTER.toLowerCase();
  const apiBaseUrl = `https://openapi-${dc}.easy4ip.com/openapi`;
  const nowMs = Date.now();
  const bufferMs = 300000; // 5-minute buffer

  let cache = readCache();
  let accessToken = cache.accessToken;

  if (!accessToken || (cache.accessTokenExpiresAt - nowMs) < bufferMs) {
    console.log('[Imou] Fetching new accessToken...');
    const time = Math.floor(nowMs / 1000);
    const nonce = uuidv4();
    const sign = generateSign(time, nonce, IMOU_APP_SECRET);
    const id = uuidv4();

    const tokenRes = await axios.post(`${apiBaseUrl}/accessToken`, {
      system: { ver: "1.0", appId: IMOU_APP_ID, sign, time, nonce },
      id,
      params: {}
    });

    const tokenData = tokenRes.data;
    if (!tokenData.result || tokenData.result.code !== "0") {
      throw new Error(`Failed to fetch accessToken: ${JSON.stringify(tokenData.result)}`);
    }

    accessToken = tokenData.result.data.accessToken;
    cache.accessToken = accessToken;
    cache.accessTokenExpiresAt = nowMs + (tokenData.result.data.expireTime * 1000);
    writeCache(cache);
  }

  return accessToken;
}

// Query device local records via OpenAPI
async function queryLocalRecords(deviceId, beginTime, endTime) {
  const dc = IMOU_DATA_CENTER.toLowerCase();
  const apiBaseUrl = `https://openapi-${dc}.easy4ip.com/openapi`;
  const nowMs = Date.now();
  const time = Math.floor(nowMs / 1000);
  const nonce = uuidv4();
  const sign = generateSign(time, nonce, IMOU_APP_SECRET);
  const id = uuidv4();

  const accessToken = await getAccessToken();

  const recordsRes = await axios.post(`${apiBaseUrl}/queryLocalRecords`, {
    system: { ver: "1.0", appId: IMOU_APP_ID, sign, time, nonce },
    id,
    params: {
      token: accessToken,
      deviceId,
      channelId: "0",
      beginTime,
      endTime,
      type: "All",
      queryRange: "1-30"
    }
  });

  const recordsData = recordsRes.data;
  if (!recordsData.result || recordsData.result.code !== "0") {
    throw new Error(`Failed to query local records: ${JSON.stringify(recordsData.result)}`);
  }

  return recordsData.result.data.records || [];
}

// Get/Refresh Imou AccessToken & KitToken internally without loopback REST call
async function getKitToken(deviceId, channelId) {
  const dc = IMOU_DATA_CENTER.toLowerCase();
  const apiBaseUrl = `https://openapi-${dc}.easy4ip.com/openapi`;
  const nowMs = Date.now();
  const bufferMs = 300000; // 5-minute buffer

  let cache = readCache();
  const accessToken = await getAccessToken();

  // Fetch or Reuse Kit Token
  const kitKey = `${deviceId}:${channelId}`;
  let kitToken = cache.kitTokens[kitKey] ? cache.kitTokens[kitKey].token : null;
  const kitTokenExpiresAt = cache.kitTokens[kitKey] ? cache.kitTokens[kitKey].expiresAt : 0;

  if (!kitToken || (kitTokenExpiresAt - nowMs) < bufferMs) {
    console.log(`[Imou] Fetching new kitToken for ${kitKey}...`);
    const time2 = Math.floor(nowMs / 1000);
    const nonce2 = uuidv4();
    const sign2 = generateSign(time2, nonce2, IMOU_APP_SECRET);
    const id2 = uuidv4();

    const kitTokenRes = await axios.post(`${apiBaseUrl}/getKitToken`, {
      system: { ver: "1.0", appId: IMOU_APP_ID, sign: sign2, time: time2, nonce: nonce2 },
      id: id2,
      params: {
        token: accessToken,
        deviceId,
        channelId: String(channelId),
        type: "2"
      }
    });

    const kitTokenData = kitTokenRes.data;
    if (!kitTokenData.result || kitTokenData.result.code !== "0") {
      throw new Error(`Failed to fetch kitToken: ${JSON.stringify(kitTokenData.result)}`);
    }

    kitToken = kitTokenData.result.data.kitToken;
    cache.kitTokens[kitKey] = {
      token: kitToken,
      expiresAt: nowMs + (kitTokenData.result.data.expireTime * 1000)
    };
    writeCache(cache);
  }

  return kitToken;
}

// Upload file to Cloudflare R2
async function uploadToR2(filePath, filename) {
  if (!s3Client) {
    throw new Error('Cloudflare R2 is not configured.');
  }
  console.log(`[Cloudflare R2] Uploading ${filename} to bucket ${R2_BUCKET_NAME}...`);
  const fileStream = fs.createReadStream(filePath);
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: filename,
    Body: fileStream,
    ContentType: 'video/mp4'
  });

  await s3Client.send(command);

  const cleanBaseUrl = R2_PUBLIC_URL_CUSTOM_DOMAIN.replace(/\/$/, '');
  const publicUrl = `${cleanBaseUrl}/${filename}`;
  console.log(`[Cloudflare R2] Upload successful. Public URL: ${publicUrl}`);
  return publicUrl;
}

// Centralized Recording and Upload Flow
async function recordAndUploadFlow({
  dropId,
  deviceId,
  safetyCode,
  beginTime,
  endTime,
  speed = 1
}) {
  const startMs = new Date(beginTime).getTime();
  const endMs = new Date(endTime).getTime();
  const durationSec = Math.floor((endMs - startMs) / 1000);

  if (durationSec <= 0) {
    throw new Error("endTime must be after beginTime");
  }

  const tempDownloadPath = path.join(TEMP_DIR, uuidv4());
  fs.mkdirSync(tempDownloadPath, { recursive: true });

  let browser = null;

  try {
    // 1. Retrieve the kitToken
    const kitToken = await getKitToken(deviceId, 0);

    // 2. Build the headless player recording URL
    const params = new URLSearchParams({
      deviceId,
      channelId: '0',
      kitToken,
      beginTime,
      endTime,
      code: safetyCode || deviceId,
      dataCenter: IMOU_DATA_CENTER
    });
    const recorderUrl = `http://localhost:${PORT}/recorder.html?${params.toString()}`;

    console.log(`[Puppeteer] Launching browser...`);
    const puppeteerModule = await import('puppeteer');
    const puppeteer = puppeteerModule.default || puppeteerModule;
    // Detect environment
    const isWindows = process.platform === 'win32';
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];

    if (!isWindows) {
      // Force software rendering for WebGL in virtualized Linux environments
      process.env.LIBGL_ALWAYS_SOFTWARE = '1';
      launchArgs.push(
        '--disable-gpu',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      );
    }

    browser = await puppeteer.launch({
      headless: true,
      args: launchArgs
    });

    const page = await browser.newPage();

    // Log messages from headless browser console
    page.on('console', msg => console.log('[Browser Console]', msg.text()));
    page.on('pageerror', err => console.error('[Browser Error]', err.toString()));
    page.on('request', request => {
      console.log(`[Browser Request Initiated] ${request.method()} ${request.url()}`);
    });
    page.on('requestfailed', request => {
      console.log(`[Browser Resource Request Failed] ${request.url()} - ${request.failure() ? request.failure().errorText : 'unknown'}`);
    });
    page.on('response', response => {
      const status = response.status();
      // Ignore 304 (Not Modified) caching redirects, as they are not errors
      if (!response.ok() && status !== 304) {
        console.log(`[Browser Response Non-OK] ${response.url()} status=${status}`);
      }
    });

    // Intercept download destination directory
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: tempDownloadPath
    });

    console.log(`[Puppeteer] Navigating to: ${recorderUrl}`);
    await page.goto(recorderUrl);

    // Wait for the player to initialize and stream
    console.log(`[Puppeteer] Waiting for playback stream start...`);
    let isPlaying = false;
    const playStartTimeout = Date.now();

    while (Date.now() - playStartTimeout < 30000) { // 30s timeout
      isPlaying = await page.evaluate(() => window.recorderStatus.playing);
      if (isPlaying) break;

      const errorMsg = await page.evaluate(() => window.recorderStatus.error);
      if (errorMsg) {
        throw new Error(`Player Initialization Error: ${JSON.stringify(errorMsg)}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!isPlaying) {
      throw new Error("Timeout waiting for player video stream to start playing.");
    }

    // 3. Start compiling the stream via MediaRecorder
    console.log(`[Puppeteer] Stream active. Starting recording...`);
    await page.evaluate(() => window.startRecording());

    // Speed up playback to record in accelerated time
    const recordSpeed = Number(speed);
    await page.evaluate((s) => window.setPlaybackSpeed(s), recordSpeed);

    // Sleep for the calculated accelerated duration + buffer
    const recordingDurationMs = Math.ceil((durationSec / recordSpeed) * 1000) + 2500;
    console.log(`[Puppeteer] Recording for ${durationSec}s at ${recordSpeed}x speed (waiting ${recordingDurationMs / 1000}s)...`);
    await new Promise(r => setTimeout(r, recordingDurationMs));

    // 4. Stop recording to trigger browser file compilation and download
    console.log(`[Puppeteer] Playback duration complete. Stopping record...`);
    await page.evaluate(() => window.stopRecording());

    console.log(`[Puppeteer] Waiting for local download completion...`);
    const downloadedFile = await waitForDownload(tempDownloadPath);

    if (!downloadedFile) {
      throw new Error("Video recording download timed out or failed.");
    }

    // Move file to static videos folder for local fallback
    const filename = `drop_${dropId}_${deviceId}_${Math.floor(startMs / 1000)}.mp4`;
    const finalLocalPath = path.join(VIDEOS_DIR, filename);
    fs.renameSync(downloadedFile, finalLocalPath);
    console.log(`[Puppeteer] Saved video locally to: ${finalLocalPath}`);

    // Keep only the 10 latest video files in public/videos folder
    cleanupOldVideos();

    // 5. Upload to Cloudflare R2
    const publicUrl = await uploadToR2(finalLocalPath, filename);

    // 6. Update database record
    if (supabase) {
      console.log(`[Supabase] Updating drop record ${dropId} with drop_cam_url...`);
      const { error: updateError } = await supabase
        .from('drops')
        .update({ drop_cam_url: publicUrl })
        .eq('id', dropId);

      if (updateError) {
        throw new Error(`Failed to update Supabase record: ${updateError.message}`);
      }
      console.log(`[Supabase] Update successful.`);
    }

    return {
      success: true,
      filename,
      localVideoUrl: `http://localhost:${PORT}/videos/${filename}`,
      publicUrl
    };

  } finally {
    if (browser) {
      await browser.close();
    }
    // Cleanup temporary download directories
    try {
      if (fs.existsSync(tempDownloadPath)) {
        fs.rmSync(tempDownloadPath, { recursive: true, force: true });
      }
    } catch (cleanErr) {
      console.error("Cleanup temp folders error:", cleanErr.message);
    }
  }
}

// FIFO Queue to handle sequential recording tasks
const recordingQueue = [];
let isProcessingQueue = false;

async function processRecordingQueue() {
  if (isProcessingQueue || recordingQueue.length === 0) {
    return;
  }
  isProcessingQueue = true;
  const job = recordingQueue.shift();

  console.log(`[Queue] Starting video recording task for drop ${job.dropId}. Remaining in queue: ${recordingQueue.length}`);
  try {
    const result = await recordAndUploadFlow({
      dropId: job.dropId,
      deviceId: job.deviceId,
      safetyCode: job.safetyCode,
      beginTime: job.beginTime,
      endTime: job.endTime,
      speed: 1 // Forced speed to 1 as speed 8 causes empty or unusable videos
    });
    console.log(`[Queue] Finished job for drop ${job.dropId} successfully.`, result);
  } catch (err) {
    console.error(`[Queue Error] Failed to process job for drop ${job.dropId}:`, err.message);
  } finally {
    isProcessingQueue = false;
    // Process next item asynchronously
    setImmediate(processRecordingQueue);
  }
}

// Initialize MQTT Client and subscribe to topic
function initMqtt() {
  console.log(`[MQTT] Connecting to broker: ${MQTT_BROKER_URL}...`);
  const client = mqtt.connect(MQTT_BROKER_URL);

  client.on('connect', () => {
    console.log(`[MQTT] Connected. Subscribing to topic: ${MQTT_TOPIC}`);
    client.subscribe(MQTT_TOPIC, (err) => {
      if (err) {
        console.error(`[MQTT] Subscription error on topic ${MQTT_TOPIC}:`, err.message);
      }
    });
  });

  client.on('message', async (topic, message) => {
    const payload = message.toString().trim();
    console.log(`[MQTT] Received message on ${topic}: "${payload}"`);

    // Parse body format: "drop, <drop_id>"
    const parts = payload.split(',');
    if (parts.length === 2 && parts[0].trim().toLowerCase() === 'drop') {
      const dropIdStr = parts[1].trim();
      const dropId = parseInt(dropIdStr, 10);

      if (isNaN(dropId)) {
        console.error(`[MQTT] Error: Invalid drop_id received: "${dropIdStr}"`);
        return;
      }

      console.log(`[MQTT] Queueing processing flow for drop_id: ${dropId}`);

      try {
        if (!supabase) {
          throw new Error('Supabase client is not configured. Cannot process MQTT trigger.');
        }

        // 1. Fetch machine_id from drop table
        console.log(`[Supabase] Fetching machine_id for drop_id: ${dropId}...`);
        const { data: dropData, error: dropError } = await supabase
          .from('drops')
          .select('machine_id')
          .eq('id', dropId)
          .single();

        if (dropError || !dropData) {
          throw new Error(`Failed to find drop with id ${dropId}: ${dropError?.message}`);
        }

        const machineId = dropData.machine_id;
        console.log(`[Supabase] Found machine_id: ${machineId}. Querying camera SN and safecode...`);

        // 2. Fetch camera device ID and safecode from machine table
        const { data: machineData, error: machineError } = await supabase
          .from('machines')
          .select('camera_device_id, camera_safecode')
          .eq('id', machineId)
          .single();

        if (machineError || !machineData) {
          throw new Error(`Failed to find machine with id ${machineId}: ${machineError?.message}`);
        }

        const deviceId = machineData.camera_device_id;
        const safetyCode = machineData.camera_safecode;

        if (!deviceId) {
          throw new Error(`Machine ${machineId} does not have a camera_device_id set.`);
        }

        // 3. Compute dynamic time bounds (eventTime - 7s to eventTime + 7s) in camera timezone
        const now = new Date();
        const start = new Date(now.getTime() - 7000);
        const end = new Date(now.getTime() + 7000);

        const beginTime = formatDate(start);
        const endTime = formatDate(end);
        // Optional: Wait 15 seconds to allow the camera to finalize the record file on the SD card
        console.log('[Imou] Waiting 5 seconds for camera to write the video file to SD card...');
        await new Promise(r => setTimeout(r, 5000));

        console.log(`[MQTT Job] Queueing job parameters:
          - Drop ID: ${dropId}
          - Device SN: ${deviceId}
          - Safety Code: ${safetyCode ? '***' : '(Not Configured/Fallback to SN)'}
          - Range: ${beginTime} to ${endTime}`);

        // 4. Push to FIFO Queue and process
        recordingQueue.push({
          dropId,
          deviceId,
          safetyCode,
          beginTime,
          endTime
        });

        processRecordingQueue();

      } catch (err) {
        console.error(`[MQTT Job Error] Failed to queue MQTT message for drop ${dropId}:`, err.message);
      }
    } else {
      console.log(`[MQTT] Ignored non-conforming message: "${payload}"`);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT Client Error]', err.message);
  });
}

// Start MQTT client connection
initMqtt();

// Keep HTTP Server endpoints for debugging/manual triggers
app.post('/api/localRecords', async (req, res) => {
  const { deviceId, channelId } = req.body;
  if (!deviceId || channelId === undefined) {
    return res.status(400).json({ success: false, error: "Missing deviceId or channelId" });
  }
  try {
    const kitToken = await getKitToken(deviceId, channelId);
    res.json({ success: true, kitToken });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual trigger API endpoint to test the recording pipeline
app.post('/api/saveLocalVideo', async (req, res) => {
  const {
    dropId = 999,
    deviceId,
    safetyCode,
    beginTime,
    endTime,
    speed
  } = req.body;

  if (!deviceId || !beginTime || !endTime) {
    return res.status(400).json({ success: false, error: "Missing required params: deviceId, beginTime, endTime" });
  }

  try {
    const result = await recordAndUploadFlow({
      dropId,
      deviceId,
      safetyCode,
      beginTime,
      endTime,
      speed
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Imou Playback API server running on port ${PORT}`);
});
