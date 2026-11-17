import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PublicClient } from "./api";
import "./index.css";

// /w/<publicKey> is the iframe inside the website bubble; /b/<publicKey> is the full-page hosted chat.
const [, kind = "", publicKey = ""] = window.location.pathname.split("/");
const channel = kind === "b" ? "hosted" : "widget";
const client = new PublicClient(decodeURIComponent(publicKey), channel);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App client={client} channel={channel} />
  </StrictMode>,
);
