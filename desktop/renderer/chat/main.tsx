import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./page";
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <ChatApp />
  </StrictMode>,
);
