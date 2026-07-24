import "../env.js"; // load .env so MQTT_BROKER_PORT is picked up before we read it
import { startEmbeddedBroker } from "./mqtt.js";

const port = Number(process.env.MQTT_BROKER_PORT ?? 1883);

startEmbeddedBroker(port)
  .then(() => console.log(`[broker] Aedes MQTT broker listening on :${port}`))
  .catch((err) => {
    console.error("[broker] fatal:", err);
    process.exit(1);
  });
