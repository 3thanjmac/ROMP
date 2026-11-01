import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/global.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { initNet } from "./lib/conn/net.svelte";
import { initExternalLinks } from "./lib/external";
import { initViewport } from "./lib/shell/viewport.svelte";

initViewport();
initNet();
initExternalLinks();

const target = document.getElementById("app");
if (!target) throw new Error("#app is missing from index.html");
mount(App, { target });
