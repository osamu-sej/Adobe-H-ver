import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startAutosave } from "./model/autosave";
import "./styles.css";

startAutosave();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
