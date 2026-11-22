/* BusPulse front-end configuration.
   Every value can also be overridden in the address bar, e.g.
   dashboard/index.html?mode=live&broker=wss://<lab-host>:<port>/mqtt
*/
window.BUSPULSE_CONFIG = {
  // "demo": data simulated inside the browser (works offline, for drafts and screenshots)
  // "live": data from the MQTT broker (Python simulator now, Raspberry Pi later)
  mode: "demo",

  mqtt: {
    url: "ws://localhost:9001",      // local broker; for the lab use its wss:// address
    topicPrefix: "buspulse/bus",     // same prefix as simulator/bus_simulator.py
    username: "",
    password: ""
  },

  demo: {
    buses: 6,
    speed: 20,          // simulated seconds per real second
    startHour: 8.0,     // simulated clock starts here (8.0 = 08:00)
    warmupMinutes: 120,  // history generated instantly so the charts are not empty
    seed: 42,
    faultBus: "BP-1124" // bus with a simulated ventilation fault
  },

  // Optional: the lab's LLM service. Leave url empty to use the built-in rule-based answers.
  // Any OpenAI-compatible /v1/chat/completions endpoint works.
  llm: { url: "", model: "", apiKey: "" },

  // Optional: Grafana dashboard to embed in the "Comfort & air" view (Konstantinos' panels).
  grafanaUrl: ""
};
