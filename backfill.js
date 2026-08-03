require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const mqtt = require('mqtt');
const readline = require('readline');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'cmaphcm/cam-cut';
const CAMERA_TIMEZONE = process.env.CAMERA_TIMEZONE || 'Asia/Ho_Chi_Minh';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Error: SUPABASE_URL and SUPABASE_KEY must be set in your .env file.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

function parseDateTime(str, isEnd = false) {
  let cleaned = str.trim();

  // If the user inputs a date-only (like YYYY-MM-DD or YYYY/MM/DD)
  const dateOnlyRegex = /^\d{4}[-/]\d{2}[-/]\d{2}$/;
  if (dateOnlyRegex.test(cleaned)) {
    cleaned += isEnd ? ' 23:59:59' : ' 00:00:00';
  }

  // Check if it already has timezone designators (Z or +HH:mm or -HH:mm)
  if (cleaned.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(cleaned)) {
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid date/time format: "${str}"`);
    }
    return d.toISOString();
  }

  // Parse YYYY-MM-DD HH:mm:ss components
  const parts = cleaned.match(/\d+/g);
  if (!parts || parts.length < 3) {
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid date/time format: "${str}"`);
    }
    return d.toISOString();
  }

  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const hour = parts[3] ? parseInt(parts[3], 10) : 0;
  const minute = parts[4] ? parseInt(parts[4], 10) : 0;
  const second = parts[5] ? parseInt(parts[5], 10) : 0;

  // Create a date assuming the input components are in UTC first
  const utcDate = new Date(Date.UTC(year, month, day, hour, minute, second));

  // Format this UTC date in the target timezone to find the offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: CAMERA_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });

  const formattedParts = formatter.formatToParts(utcDate);
  const getPart = type => parseInt(formattedParts.find(p => p.type === type).value, 10);

  const fYear = getPart('year');
  const fMonth = getPart('month') - 1;
  const fDay = getPart('day');
  let fHour = getPart('hour');
  if (fHour === 24) fHour = 0;
  const fMin = getPart('minute');
  const fSec = getPart('second');

  // Construct the formatted date in UTC
  const formattedUtcDate = new Date(Date.UTC(fYear, fMonth, fDay, fHour, fMin, fSec));

  // Difference is the offset at that specific time
  const diffMs = utcDate.getTime() - formattedUtcDate.getTime();

  // Final adjusted date representing the input local time in target timezone
  const finalDate = new Date(utcDate.getTime() + diffMs);

  if (isNaN(finalDate.getTime())) {
    throw new Error(`Invalid date/time format: "${str}"`);
  }
  return finalDate.toISOString();
}

async function getInteractiveInput() {
  console.log("=== Backfill Utility (Interactive Mode) ===");
  
  const merchantInput = await askQuestion("Enter Merchant ID: ");
  if (!merchantInput) throw new Error("Merchant ID is required.");
  const merchantId = parseInt(merchantInput, 10);
  if (isNaN(merchantId)) throw new Error("Merchant ID must be a number.");

  const startInput = await askQuestion("Enter Start Time (e.g. 2026-06-28 00:00:00 or ISO format): ");
  if (!startInput) throw new Error("Start Time is required.");
  const startTime = parseDateTime(startInput, false);

  const endInput = await askQuestion("Enter End Time (e.g. 2026-06-28 23:59:59 or ISO format): ");
  if (!endInput) throw new Error("End Time is required.");
  const endTime = parseDateTime(endInput, true);

  const delayInput = await askQuestion("Enter Delay between MQTT publishes in ms [default: 1500]: ");
  const delay = delayInput ? parseInt(delayInput, 10) : 1500;
  if (isNaN(delay)) throw new Error("Delay must be a valid number.");

  return { merchantId, startTime, endTime, delay };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const params = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--merchant' || arg === '-m') {
      params.merchantId = parseInt(args[++i], 10);
    } else if (arg === '--start' || arg === '-s') {
      params.startTime = parseDateTime(args[++i], false);
    } else if (arg === '--end' || arg === '-e') {
      params.endTime = parseDateTime(args[++i], true);
    } else if (arg === '--delay' || arg === '-d') {
      params.delay = parseInt(args[++i], 10);
    }
  }

  // Validate if some CLI arguments are provided, all required ones must be set
  const hasSomeArgs = Object.keys(params).length > 0;
  if (hasSomeArgs) {
    if (params.merchantId === undefined || isNaN(params.merchantId)) {
      throw new Error("Missing or invalid --merchant (-m) argument.");
    }
    if (!params.startTime) {
      throw new Error("Missing or invalid --start (-s) argument.");
    }
    if (!params.endTime) {
      throw new Error("Missing or invalid --end (-e) argument.");
    }
    if (params.delay === undefined) {
      params.delay = 1500;
    }
    return params;
  }
  
  return null;
}

async function main() {
  let inputs;
  try {
    inputs = parseCliArgs();
    if (!inputs) {
      inputs = await getInteractiveInput();
    }
  } catch (err) {
    console.error("Error parsing inputs:", err.message);
    console.log("\nUsage:\n  node backfill.js -m <merchantId> -s <startTime> -e <endTime> [-d <delayMs>]\n");
    process.exit(1);
  }

  const { merchantId, startTime, endTime, delay } = inputs;
  
  console.log("\n------------------------------------------------");
  console.log(`Merchant ID: ${merchantId}`);
  console.log(`Start Time:  ${startTime} (${new Date(startTime).toLocaleString()})`);
  console.log(`End Time:    ${endTime} (${new Date(endTime).toLocaleString()})`);
  console.log(`Delay:       ${delay}ms`);
  console.log("------------------------------------------------\n");

  try {
    // 1. Fetch machines for the merchant
    console.log(`[Supabase] Querying machines for merchant_id ${merchantId}...`);
    const { data: machines, error: machinesError } = await supabase
      .from('machines')
      .select('id, name, codename, camera_device_id')
      .eq('merchant_id', merchantId);

    if (machinesError) {
      throw new Error(`Failed to query machines: ${machinesError.message}`);
    }

    if (!machines || machines.length === 0) {
      console.log(`No machines found for merchant_id ${merchantId}. Nothing to backfill.`);
      return;
    }

    const machineIds = machines.map(m => m.id);
    const machineMap = new Map(machines.map(m => [m.id, m]));
    console.log(`Found ${machines.length} machine(s): ${machines.map(m => `${m.name} (${m.id})`).join(', ')}`);

    // 2. Fetch drops for these machines in the given range
    console.log(`[Supabase] Querying drops for machine IDs [${machineIds.join(', ')}] created between ${startTime} and ${endTime}...`);
    const { data: drops, error: dropsError } = await supabase
      .from('drops')
      .select('id, machine_id, created_at')
      .in('machine_id', machineIds)
      .gte('created_at', startTime)
      .lte('created_at', endTime)
      .order('created_at', { ascending: true });

    if (dropsError) {
      throw new Error(`Failed to query drops: ${dropsError.message}`);
    }

    if (!drops || drops.length === 0) {
      console.log("No drops found within this time range for the merchant.");
      return;
    }

    console.log(`Found ${drops.length} drops to backfill!`);

    // 3. Connect to MQTT Broker
    console.log(`[MQTT] Connecting to broker at ${MQTT_BROKER_URL}...`);
    const client = mqtt.connect(MQTT_BROKER_URL);

    client.on('error', (err) => {
      console.error('[MQTT Client Error]', err.message);
    });

    await new Promise((resolve, reject) => {
      const connTimeout = setTimeout(() => {
        reject(new Error("Timeout connecting to MQTT broker"));
      }, 10000);

      client.on('connect', () => {
        clearTimeout(connTimeout);
        console.log('[MQTT] Connected successfully.');
        resolve();
      });
      client.on('error', (err) => {
        clearTimeout(connTimeout);
        reject(err);
      });
    });

    // 4. Publish each drop simulation sequentially with delay
    for (let i = 0; i < drops.length; i++) {
      const drop = drops[i];
      const machine = machineMap.get(drop.machine_id);
      const payload = `drop, ${drop.id}`;

      console.log(`[${i + 1}/${drops.length}] Publishing drop ${drop.id} (Machine: ${machine ? machine.name : drop.machine_id}, Created at: ${drop.created_at})`);
      
      await new Promise((resolve, reject) => {
        client.publish(MQTT_TOPIC, payload, { qos: 1 }, (err) => {
          if (err) {
            console.error(`  Failed to publish drop ${drop.id}:`, err.message);
            reject(err);
          } else {
            console.log(`  Successfully published: "${payload}"`);
            resolve();
          }
        });
      });

      // If not the last item, wait for the delay
      if (i < drops.length - 1) {
        console.log(`  Waiting ${delay}ms before next publish...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    console.log("\n[MQTT] Closing client connection...");
    client.end();
    console.log("Backfill completed successfully!");

  } catch (err) {
    console.error("Backfill operation failed:", err.message);
    process.exit(1);
  }
}

main();
