import { createTheme, Input, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import ReactDOM from "react-dom/client";
import App from "./app";
import "./assets/main.css";

const theme = createTheme({
  primaryColor: "orange",
  fontSizes: {
    xs: "11px",
    sm: "14px",
    md: "16px",
    lg: "16px",
    xl: "18px",
  },
  components: {
    Input: Input.extend({
      vars: (_theme, props) => {
        if (props.size === "xs") {
          return {
            root: {
              "--input-height": "1.25rem",
            },
            wrapper: {},
          };
        }
        return { root: {}, wrapper: {} };
      },
    }),
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <MantineProvider forceColorScheme="dark" theme={theme}>
    <ModalsProvider modalProps={{ zIndex: 1000, size: "xs" }}>
      <Notifications zIndex={1000} />
      <App />
    </ModalsProvider>
  </MantineProvider>,
);
