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
const EZVIZ_APP_KEY = process.env.EZVIZ_APP_KEY;
const EZVIZ_APP_SECRET = process.env.EZVIZ_APP_SECRET;

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

// Set headers for cross-domain security isolation required by EZUIKit Web SDK
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

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
  let prevSize = -1;
  let stableCount = 0;

  while (Date.now() - startTime < 60000) { // 60 seconds timeout
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      const crdownload = files.find(f => f.endsWith('.crdownload'));
      
      const mediaFile = files.find(f => {
        const lower = f.toLowerCase();
        return (lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.ts') || lower.endsWith('.flv') || lower.endsWith('.mkv') || lower.endsWith('.asf') || lower.endsWith('.avi')) && !lower.endsWith('.crdownload');
      });

      const candidate = mediaFile || files.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));

      if (candidate && !crdownload) {
        const fullCandidatePath = path.join(dir, candidate);
        try {
          const stats = fs.statSync(fullCandidatePath);
          if (stats.size > 0) {
            // Verify file size is stable (completed writing)
            if (stats.size === prevSize) {
              stableCount++;
              if (stableCount >= 2) {
                file = fullCandidatePath;
                break;
              }
            } else {
              prevSize = stats.size;
              stableCount = 0;
            }
          }
        } catch (e) {
          // File might be briefly locked during write
        }
      }
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

// Fetch dynamic camera credentials and brand from database merchants table
async function getCameraCredentials({ dropId, deviceId }) {
  if (!supabase) {
    return { brand: 'imou', appId: IMOU_APP_ID, appSecret: IMOU_APP_SECRET };
  }

  try {
    // 1. If valid dropId is provided, lookup machine and merchant
    if (dropId && dropId !== 999 && dropId !== '999') {
      const { data: dropData, error: dropError } = await supabase
        .from('drops')
        .select('machine_id')
        .eq('id', dropId)
        .single();

      if (!dropError && dropData && dropData.machine_id) {
        const { data: machineData, error: machineError } = await supabase
          .from('machines')
          .select('camera_brand, merchants (*)')
          .eq('id', dropData.machine_id)
          .single();

        if (!machineError && machineData) {
          const brand = machineData.camera_brand || 'imou';
          if (brand === 'ezviz') {
            const appKey = machineData.merchants?.ezviz_app_key || EZVIZ_APP_KEY;
            const appSecret = machineData.merchants?.ezviz_app_secret || EZVIZ_APP_SECRET;
            if (appKey && appSecret) {
              console.log(`[Credentials] Found custom EZVIZ credentials in DB for dropId ${dropId} (appKey: ${appKey})`);
              return { brand, appId: appKey, appSecret };
            }
          } else {
            const appId = machineData.merchants?.imou_app_id || IMOU_APP_ID;
            const appSecret = machineData.merchants?.imou_app_secret || IMOU_APP_SECRET;
            if (appId && appSecret) {
              console.log(`[Credentials] Found custom Imou credentials in DB for dropId ${dropId} (appId: ${appId})`);
              return { brand, appId, appSecret };
            }
          }
        }
      }
    }

    // 2. Fallback to lookup by device ID if available
    if (deviceId) {
      const { data: machineData, error: machineError } = await supabase
        .from('machines')
        .select('camera_brand, merchants (*)')
        .eq('camera_device_id', deviceId)
        .limit(1)
        .maybeSingle();

      if (!machineError && machineData) {
        const brand = machineData.camera_brand || 'imou';
        if (brand === 'ezviz') {
          const appKey = machineData.merchants?.ezviz_app_key || EZVIZ_APP_KEY;
          const appSecret = machineData.merchants?.ezviz_app_secret || EZVIZ_APP_SECRET;
          if (appKey && appSecret) {
            console.log(`[Credentials] Found custom EZVIZ credentials in DB for deviceId ${deviceId} (appKey: ${appKey})`);
            return { brand, appId: appKey, appSecret };
          }
        } else {
          const appId = machineData.merchants?.imou_app_id || IMOU_APP_ID;
          const appSecret = machineData.merchants?.imou_app_secret || IMOU_APP_SECRET;
          if (appId && appSecret) {
            console.log(`[Credentials] Found custom Imou credentials in DB for deviceId ${deviceId} (appId: ${appId})`);
            return { brand, appId, appSecret };
          }
        }
      }
    }
  } catch (err) {
    console.error('[Credentials Lookup Error] Failed to fetch dynamic credentials:', err.message);
  }

  // 3. Fallback to default environment credentials
  return { brand: 'imou', appId: IMOU_APP_ID, appSecret: IMOU_APP_SECRET };
}

// Get or refresh EZVIZ AccessToken
async function getEzvizAccessToken(appKey, appSecret) {
  const nowMs = Date.now();
  const bufferMs = 300000; // 5-minute buffer

  let cache = readCache();
  if (!cache.accounts) {
    cache.accounts = {};
  }
  if (!cache.accounts[appKey]) {
    cache.accounts[appKey] = { accessToken: null, accessTokenExpiresAt: 0, areaDomain: '' };
  }

  const account = cache.accounts[appKey];
  let accessToken = account.accessToken;

  if (!accessToken || (account.accessTokenExpiresAt - nowMs) < bufferMs) {
    console.log(`[EZVIZ] Fetching new accessToken for appKey ${appKey}...`);
    const params = new URLSearchParams();
    params.append('appKey', appKey);
    params.append('appSecret', appSecret);

    const tokenRes = await axios.post('https://open.ezvizlife.com/api/lapp/token/get', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const tokenData = tokenRes.data;
    if (tokenData.code !== "200" || !tokenData.data) {
      throw new Error(`Failed to fetch EZVIZ accessToken for appKey ${appKey}: ${JSON.stringify(tokenData)}`);
    }

    accessToken = tokenData.data.accessToken;
    account.accessToken = accessToken;
    account.accessTokenExpiresAt = tokenData.data.expireTime; // Already in ms timestamp format
    account.areaDomain = tokenData.data.areaDomain || 'https://open.ezvizlife.com';
    writeCache(cache);
  }

  return { accessToken, areaDomain: account.areaDomain || 'https://open.ezvizlife.com' };
}

// Get EZVIZ playback URL from the platform API
async function getEzvizPlayUrl({ appKey, appSecret, deviceSerial, channelNo = 1, type = 2, code = '', startTime, stopTime }) {
  const { accessToken, areaDomain } = await getEzvizAccessToken(appKey, appSecret);

  console.log(`[EZVIZ] Requesting play address for device ${deviceSerial} via ${areaDomain}...`);
  const params = new URLSearchParams();
  params.append('accessToken', accessToken);
  params.append('deviceSerial', deviceSerial);
  params.append('channelNo', String(channelNo));
  params.append('protocol', '1'); // 1-ezopen
  if (code) {
    params.append('code', code);
  }
  params.append('type', String(type)); // 2-local recording playback, 3-CloudPlay recording playback
  params.append('startTime', startTime);
  params.append('stopTime', stopTime);

  const res = await axios.post(`${areaDomain}/api/lapp/live/address/get`, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  const resData = res.data;
  if (resData.code !== '200' || !resData.data || !resData.data.url) {
    throw new Error(`Failed to get EZVIZ play address: ${JSON.stringify(resData)}`);
  }

  console.log(`[EZVIZ] Successfully obtained play address: ${resData.data.url}`);
  return resData.data.url;
}

// Get or refresh Imou AccessToken
async function getAccessToken(appId, appSecret) {
  const dc = IMOU_DATA_CENTER.toLowerCase();
  const apiBaseUrl = `https://openapi-${dc}.easy4ip.com/openapi`;
  const nowMs = Date.now();
  const bufferMs = 300000; // 5-minute buffer

  let cache = readCache();
  if (!cache.accounts) {
    cache.accounts = {};
  }
  if (!cache.accounts[appId]) {
    cache.accounts[appId] = { accessToken: null, accessTokenExpiresAt: 0, kitTokens: {} };
  }

  const account = cache.accounts[appId];
  let accessToken = account.accessToken;

  if (!accessToken || (account.accessTokenExpiresAt - nowMs) < bufferMs) {
    console.log(`[Imou] Fetching new accessToken for appId ${appId}...`);
    const time = Math.floor(nowMs / 1000);
    const nonce = uuidv4();
    const sign = generateSign(time, nonce, appSecret);
    const id = uuidv4();

    const tokenRes = await axios.post(`${apiBaseUrl}/accessToken`, {
      system: { ver: "1.0", appId, sign, time, nonce },
      id,
      params: {}
    });

    const tokenData = tokenRes.data;
    if (!tokenData.result || tokenData.result.code !== "0") {
      throw new Error(`Failed to fetch accessToken for appId ${appId}: ${JSON.stringify(tokenData.result)}`);
    }

    accessToken = tokenData.result.data.accessToken;
    account.accessToken = accessToken;
    account.accessTokenExpiresAt = nowMs + (tokenData.result.data.expireTime * 1000);
    writeCache(cache);
  }

  return accessToken;
}

// Query device local records via OpenAPI
async function queryLocalRecords(deviceId, beginTime, endTime, appId, appSecret) {
  const dc = IMOU_DATA_CENTER.toLowerCase();
  const apiBaseUrl = `https://openapi-${dc}.easy4ip.com/openapi`;
  const nowMs = Date.now();
  const time = Math.floor(nowMs / 1000);
  const nonce = uuidv4();
  const sign = generateSign(time, nonce, appSecret);
  const id = uuidv4();

  const accessToken = await getAccessToken(appId, appSecret);

  const recordsRes = await axios.post(`${apiBaseUrl}/queryLocalRecords`, {
    system: { ver: "1.0", appId, sign, time, nonce },
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
async function getKitToken(deviceId, channelId, appId, appSecret, forceRefresh = false) {
  const dc = IMOU_DATA_CENTER.toLowerCase();
  const apiBaseUrl = `https://openapi-${dc}.easy4ip.com/openapi`;
  const nowMs = Date.now();
  const bufferMs = 300000; // 5-minute buffer

  let cache = readCache();
  if (!cache.accounts) {
    cache.accounts = {};
  }
  if (!cache.accounts[appId]) {
    cache.accounts[appId] = { accessToken: null, accessTokenExpiresAt: 0, kitTokens: {} };
  }

  const account = cache.accounts[appId];
  const accessToken = await getAccessToken(appId, appSecret);

  // Fetch or Reuse Kit Token
  const kitKey = `${deviceId}:${channelId}`;
  let kitToken = (!forceRefresh && account.kitTokens[kitKey]) ? account.kitTokens[kitKey].token : null;
  const kitTokenExpiresAt = (!forceRefresh && account.kitTokens[kitKey]) ? account.kitTokens[kitKey].expiresAt : 0;

  if (!kitToken || (kitTokenExpiresAt - nowMs) < bufferMs) {
    console.log(`[Imou] Fetching new kitToken for ${kitKey} (appId: ${appId}) (forceRefresh: ${forceRefresh})...`);
    const time2 = Math.floor(nowMs / 1000);
    const nonce2 = uuidv4();
    const sign2 = generateSign(time2, nonce2, appSecret);
    const id2 = uuidv4();

    const kitTokenRes = await axios.post(`${apiBaseUrl}/getKitToken`, {
      system: { ver: "1.0", appId, sign: sign2, time: time2, nonce: nonce2 },
      id: id2,
      params: {
        token: accessToken,
        deviceId,
        channelId: String(channelId),
        type: "0"
      }
    });

    const kitTokenData = kitTokenRes.data;
    if (!kitTokenData.result || kitTokenData.result.code !== "0") {
      throw new Error(`Failed to fetch kitToken for ${kitKey} (appId: ${appId}): ${JSON.stringify(kitTokenData.result)}`);
    }

    kitToken = kitTokenData.result.data.kitToken;
    account.kitTokens[kitKey] = {
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
  cameraStorageType,
  cameraBrand,
  beginTime,
  endTime,
  speed = 1,
  appId,
  appSecret,
  forceRefreshKitToken = false
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
    // 1. Resolve dynamic credentials and brand if not pre-fetched
    let resolvedBrand = cameraBrand;
    let resolvedAppId = appId;
    let resolvedAppSecret = appSecret;
    if (!resolvedBrand || !resolvedAppId || !resolvedAppSecret) {
      const creds = await getCameraCredentials({ dropId, deviceId });
      resolvedBrand = resolvedBrand || creds.brand;
      resolvedAppId = resolvedAppId || creds.appId;
      resolvedAppSecret = resolvedAppSecret || creds.appSecret;
    }
    resolvedBrand = resolvedBrand || 'imou';

    // 2. Resolve camera storage type
    let resolvedStorageType = cameraStorageType;
    if (!resolvedStorageType && supabase) {
      try {
        if (dropId && dropId !== 999 && dropId !== '999') {
          const { data: dropData } = await supabase
            .from('drops')
            .select('machine_id')
            .eq('id', dropId)
            .single();
          if (dropData && dropData.machine_id) {
            const { data: machineData } = await supabase
              .from('machines')
              .select('camera_storage_type')
              .eq('id', dropData.machine_id)
              .single();
            resolvedStorageType = machineData?.camera_storage_type;
          }
        }
        if (!resolvedStorageType && deviceId) {
          const { data: machineData } = await supabase
            .from('machines')
            .select('camera_storage_type')
            .eq('camera_device_id', deviceId)
            .limit(1)
            .maybeSingle();
          resolvedStorageType = machineData?.camera_storage_type;
        }
      } catch (err) {
        console.error('[Storage Type Lookup Error] Failed to fetch camera storage type:', err.message);
      }
    }
    resolvedStorageType = resolvedStorageType || 'localRecord';

    // 3. Retrieve token, determine channel number, and fetch EZVIZ play address if needed
    let token;
    let channelId = '0';
    let ezvizPlayUrl = '';
    let ezvizAreaDomain = '';
    if (resolvedBrand === 'ezviz') {
      const ezvizType = (resolvedStorageType === 'cloud') ? 3 : 2;
      ezvizPlayUrl = await getEzvizPlayUrl({
        appKey: resolvedAppId,
        appSecret: resolvedAppSecret,
        deviceSerial: deviceId,
        channelNo: 1, // Default channel is 1
        type: ezvizType,
        code: safetyCode,
        startTime: beginTime,
        stopTime: endTime
      });
      const tokenObj = await getEzvizAccessToken(resolvedAppId, resolvedAppSecret);
      token = tokenObj.accessToken;
      ezvizAreaDomain = tokenObj.areaDomain;
      channelId = '1';
    } else {
      token = await getKitToken(deviceId, 0, resolvedAppId, resolvedAppSecret, forceRefreshKitToken);
    }

    // 4. Build the headless player recording URL
    const params = new URLSearchParams({
      brand: resolvedBrand,
      deviceId,
      channelId,
      kitToken: token,
      beginTime,
      endTime,
      code: safetyCode || '',
      dataCenter: IMOU_DATA_CENTER,
      recordType: resolvedStorageType
    });
    if (resolvedBrand === 'ezviz') {
      params.append('playUrl', ezvizPlayUrl);
      params.append('areaDomain', ezvizAreaDomain);
    }
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

    // Also set Browser.setDownloadBehavior for headless Chrome anchor & blob downloads
    try {
      const browserClient = await browser.target().createCDPSession();
      await browserClient.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: tempDownloadPath,
        eventsEnabled: true
      });
    } catch (e) {
      // Browser target CDP session might differ across environments
    }

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
    const recordSpeed = (resolvedBrand === 'ezviz') ? 1 : Number(speed);
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

  const attempt = job.attempt || 1;
  const forceRefreshKitToken = job.forceRefreshKitToken || false;

  console.log(`[Queue] Starting video recording task for drop ${job.dropId} (Attempt ${attempt}/4). Remaining in queue: ${recordingQueue.length}`);
  try {
    const result = await recordAndUploadFlow({
      dropId: job.dropId,
      deviceId: job.deviceId,
      safetyCode: job.safetyCode,
      cameraStorageType: job.cameraStorageType,
      cameraBrand: job.cameraBrand,
      beginTime: job.beginTime,
      endTime: job.endTime,
      speed: 1, // Forced speed to 1 as speed 8 causes empty or unusable videos
      appId: job.appId,
      appSecret: job.appSecret,
      forceRefreshKitToken: forceRefreshKitToken
    });
    console.log(`[Queue] Finished job for drop ${job.dropId} successfully.`, result);
  } catch (err) {
    console.error(`[Queue Error] Failed to process job for drop ${job.dropId} on attempt ${attempt}:`, err.message);

    const isTimeoutError = err.message && (
      err.message.includes("Timeout waiting for player video stream to start playing") ||
      err.message.includes("Video recording download timed out or failed")
    );

    if (isTimeoutError) {
      if (attempt < 4) {
        const nextAttempt = attempt + 1;
        const nextForceRefresh = (nextAttempt === 4);
        recordingQueue.push({
          ...job,
          attempt: nextAttempt,
          forceRefreshKitToken: nextForceRefresh
        });
        console.log(`[Queue] Re-queued drop ${job.dropId} for attempt ${nextAttempt} (forceRefreshKitToken: ${nextForceRefresh})`);
      } else {
        console.error(`[Queue Error] Drop ${job.dropId} failed after ${attempt} attempts. Skipping job.`);
      }
    } else {
      console.error(`[Queue Error] Non-timeout error for drop ${job.dropId}. Skipping job.`);
    }
  } finally {
    isProcessingQueue = false;
    // Process next item asynchronously
    setImmediate(processRecordingQueue);
  }
}

// Initialize MQTT Client and subscribe to topic
let mqttClient = null;
let mqttHealthInterval = null;
let disconnectedSeconds = 0;

function initMqtt() {
  if (mqttClient) {
    try {
      console.log('[MQTT] Ending existing client before re-initializing...');
      mqttClient.end(true);
    } catch (err) {
      console.error('[MQTT] Error closing old client:', err.message);
    }
    mqttClient = null;
  }
  if (mqttHealthInterval) {
    clearInterval(mqttHealthInterval);
    mqttHealthInterval = null;
  }

  console.log(`[MQTT] Connecting to broker: ${MQTT_BROKER_URL}...`);
  mqttClient = mqtt.connect(MQTT_BROKER_URL);

  mqttClient.on('connect', () => {
    console.log(`[MQTT] Connected. Subscribing to topic: ${MQTT_TOPIC}`);
    disconnectedSeconds = 0;
    mqttClient.subscribe(MQTT_TOPIC, (err) => {
      if (err) {
        console.error(`[MQTT] Subscription error on topic ${MQTT_TOPIC}:`, err.message);
      }
    });
  });

  mqttClient.on('offline', () => {
    console.warn('[MQTT] Client went offline.');
  });

  mqttClient.on('close', () => {
    console.warn('[MQTT] Connection closed.');
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT Client Error]', err.message);
  });

  mqttClient.on('message', async (topic, message) => {
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

        // 1. Fetch machine_id and created_at from drop table
        console.log(`[Supabase] Fetching machine_id and created_at for drop_id: ${dropId}...`);
        const { data: dropData, error: dropError } = await supabase
          .from('drops')
          .select('machine_id, created_at')
          .eq('id', dropId)
          .single();

        if (dropError || !dropData) {
          throw new Error(`Failed to find drop with id ${dropId}: ${dropError?.message}`);
        }

        const machineId = dropData.machine_id;
        console.log(`[Supabase] Found machine_id: ${machineId}. Querying camera SN and safecode...`);

        // 2. Fetch camera device ID, safecode, and merchant credentials from machine table
        const { data: machineData, error: machineError } = await supabase
          .from('machines')
          .select('camera_brand, camera_device_id, camera_safecode, camera_storage_type, merchant_id, merchants (*)')
          .eq('id', machineId)
          .single();

        console.log(`[Supabase] Found machine with id ${machineId}:`, machineData);

        if (machineError || !machineData) {
          throw new Error(`Failed to find machine with id ${machineId}: ${machineError?.message}`);
        }

        const cameraBrand = machineData.camera_brand || 'imou';
        const deviceId = machineData.camera_device_id;
        const safetyCode = machineData.camera_safecode;
        const cameraStorageType = machineData.camera_storage_type;

        let appId, appSecret;
        if (cameraBrand === 'ezviz') {
          appId = machineData.merchants?.ezviz_app_key || EZVIZ_APP_KEY;
          appSecret = machineData.merchants?.ezviz_app_secret || EZVIZ_APP_SECRET;
        } else {
          appId = machineData.merchants?.imou_app_id || IMOU_APP_ID;
          appSecret = machineData.merchants?.imou_app_secret || IMOU_APP_SECRET;
        }

        if (!deviceId) {
          throw new Error(`Machine ${machineId} does not have a camera_device_id set.`);
        }

        // 3. Compute dynamic time bounds (eventTime - 7s to eventTime + 7s) in camera timezone
        let eventTime = dropData.created_at ? new Date(dropData.created_at) : new Date();
        // for cloud record, the video time is slightly faster than the local time
        // so we need to compensate for this
        if (cameraStorageType === 'cloud') {
          eventTime = new Date(eventTime.getTime() - 5000);
        }
        const start = new Date(eventTime.getTime() - 7000);
        const end = new Date(eventTime.getTime() + 7000);

        const beginTime = formatDate(start);
        const endTime = formatDate(end);
        // Wait for the camera to finalize the record file.
        // Local SD card recordings take longer to index (15-30s); cloud is faster.
        const sdWaitMs = (cameraStorageType === 'cloud') ? 10000 : 22000;
        console.log(`[Imou] Waiting ${sdWaitMs / 1000}s for camera to write the video file (storageType: ${cameraStorageType || 'localRecord'})...`);
        await new Promise(r => setTimeout(r, sdWaitMs));

        console.log(`[MQTT Job] Queueing job parameters:
          - Drop ID: ${dropId}
          - Device SN: ${deviceId}
          - Storage Type: ${cameraStorageType || 'localRecord'}
          - Safety Code: ${safetyCode ? '***' : '(Not Configured/Fallback to SN)'}
          - Range: ${beginTime} to ${endTime}`);

        // 4. Push to FIFO Queue and process
        recordingQueue.push({
          dropId,
          deviceId,
          safetyCode,
          cameraStorageType,
          cameraBrand,
          beginTime,
          endTime,
          appId,
          appSecret
        });

        processRecordingQueue();

      } catch (err) {
        console.error(`[MQTT Job Error] Failed to queue MQTT message for drop ${dropId}:`, err.message);
      }
    } else {
      console.log(`[MQTT] Ignored non-conforming message: "${payload}"`);
    }
  });

  // Start health check interval
  disconnectedSeconds = 0;
  mqttHealthInterval = setInterval(() => {
    if (!mqttClient || !mqttClient.connected) {
      disconnectedSeconds += 30;
      console.warn(`[MQTT Health Check] MQTT client is disconnected. (Total offline time: ${disconnectedSeconds}s)`);
      if (disconnectedSeconds >= 60) {
        console.error(`[MQTT Health Check] Connection lost for ${disconnectedSeconds}s. Force resetting connection...`);
        resetMqttConnection();
      }
    } else {
      if (disconnectedSeconds > 0) {
        console.log(`[MQTT Health Check] Connection recovered. Resetting counter.`);
      }
      disconnectedSeconds = 0;
    }
  }, 30000); // Check every 30 seconds
}

function resetMqttConnection() {
  console.log('[MQTT] Resetting connection...');
  initMqtt();
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
    const creds = await getCameraCredentials({ deviceId });
    let token;
    if (creds.brand === 'ezviz') {
      const tokenObj = await getEzvizAccessToken(creds.appId, creds.appSecret);
      token = tokenObj.accessToken;
    } else {
      token = await getKitToken(deviceId, channelId, creds.appId, creds.appSecret);
    }
    res.json({ success: true, token, brand: creds.brand });
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
    cameraBrand,
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
      cameraBrand,
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
  console.log(`Imou/EZVIZ Playback API server running on port ${PORT}`);
});
