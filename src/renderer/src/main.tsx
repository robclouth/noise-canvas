import "@fontsource-variable/inter";
import { createTheme, Input, MantineProvider, Menu, Popover } from "@mantine/core";
import "@mantine/core/styles.css";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import ReactDOM from "react-dom/client";
import App from "./app";
import "./assets/main.css";
import { modals } from "./components/modals";

const theme = createTheme({
  primaryColor: "orange",
  fontSizes: {
    xs: "11px",
    sm: "11px",
    md: "16px",
    lg: "16px",
    xl: "18px",
  },
  spacing: {
    xs: "8px",
    sm: "8px",
    md: "16px",
    lg: "24px",
    xl: "32px",
  },
  shadows: {
    xs: "0 2px 6px rgba(0, 0, 0, 0.35)",
    sm: "0 4px 12px rgba(0, 0, 0, 0.4)",
    md: "0 8px 20px rgba(0, 0, 0, 0.5)",
    lg: "0 14px 32px rgba(0, 0, 0, 0.55)",
    xl: "0 22px 52px rgba(0, 0, 0, 0.65), 0 6px 16px rgba(0, 0, 0, 0.5)",
  },
  fontFamily: "Inter Variable, sans-serif",
  focusClassName: "",
  components: {
    Input: Input.extend({
      vars: (_theme, props) => {
        if (props.size === "xs") {
          return {
            root: {},
            wrapper: { "--input-height": "19px", "--input-color": "#fff", "--input-padding-inline-start": "3px" },
          };
        }
        return { root: {}, wrapper: {} };
      },
    }),
    Menu: Menu.extend({ defaultProps: { shadow: "xl" } }),
    Popover: Popover.extend({ defaultProps: { shadow: "xl" } }),
  },
});

document.addEventListener(
  "mousedown",
  (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, [role="button"], [role="tab"], [role="menuitem"], [role="switch"]')) {
      e.preventDefault();
    }
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <MantineProvider forceColorScheme="dark" theme={theme}>
    <ModalsProvider
      modals={modals}
      modalProps={{
        zIndex: 1000,
        size: "xs",
        shadow: "xl",
        styles: {
          title: { fontSize: 14, fontWeight: 600 },
          body: { fontSize: "var(--mantine-font-size-sm)" },
        },
      }}
    >
      <Notifications zIndex={1000} />
      <App />
    </ModalsProvider>
  </MantineProvider>,
);
