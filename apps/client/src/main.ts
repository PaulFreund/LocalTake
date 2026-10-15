import { createApp } from "vue";
import App from "./studio/App.vue";
import "./styles.css";
createApp(App).mount("#root");
if (import.meta.env.PROD && "serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
