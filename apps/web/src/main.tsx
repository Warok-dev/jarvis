import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

const root = createRoot(document.getElementById("root")!);
if (import.meta.env.DEV && location.hash === "#preview") {
  import("./dev/Preview").then(({ Preview }) => root.render(<Preview />));
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Le service worker sert aux notifications push (iOS exige l'app installée sur l'écran d'accueil).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js");
}
