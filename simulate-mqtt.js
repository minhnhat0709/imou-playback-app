const mqtt = require('mqtt');

const MQTT_BROKER_URL = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC = 'cmaphcm/cam-cut';
const TEST_DROP_ID = process.argv[2] || '999';

console.log(`[Simulator] Connecting to MQTT broker at ${MQTT_BROKER_URL}...`);
const client = mqtt.connect(MQTT_BROKER_URL);

client.on('connect', () => {
  const payload = `drop, ${TEST_DROP_ID}`;
  console.log(`[Simulator] Connected. Publishing payload: "${payload}" to topic: "${MQTT_TOPIC}"`);
  
  client.publish(MQTT_TOPIC, payload, { qos: 1 }, (err) => {
    if (err) {
      console.error('[Simulator] Failed to publish message:', err.message);
    } else {
      console.log('[Simulator] Message published successfully!');
    }
    client.end();
  });
});

client.on('error', (err) => {
  console.error('[Simulator Error]', err.message);
});
