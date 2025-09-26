import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app";
import "./assets/main.css";

const theme = createTheme({
  primaryColor: "orange",
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider forceColorScheme="dark" theme={theme}>
      <Notifications />
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
