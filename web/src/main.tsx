import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "../../src/app/globals.css";
import { MotionProvider } from "../../src/components/layout/MotionProvider";
import { SessionProvider } from "./auth/session";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode><HashRouter><MotionProvider><SessionProvider><App /></SessionProvider></MotionProvider></HashRouter></StrictMode>,
);
