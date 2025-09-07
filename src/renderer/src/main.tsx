import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import App from "./App";
import "./assets/main.css";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { store } from "./store";
import { Provider as JotaiProvider } from "jotai";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <JotaiProvider store={store}>
      <MantineProvider forceColorScheme="dark">
        <Notifications />
        <App />
      </MantineProvider>
    </JotaiProvider>
  </React.StrictMode>,
);
