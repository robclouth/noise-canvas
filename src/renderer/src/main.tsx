import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import { Provider as JotaiProvider } from "jotai";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app";
import "./assets/main.css";
import { store } from "./store";

const theme = createTheme({
  primaryColor: "orange",
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <JotaiProvider store={store}>
      <MantineProvider forceColorScheme="dark" theme={theme}>
        <Notifications />
        <App />
      </MantineProvider>
    </JotaiProvider>
  </React.StrictMode>,
);
