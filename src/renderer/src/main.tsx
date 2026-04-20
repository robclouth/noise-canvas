import "@fontsource-variable/inter";
import { createTheme, Input, MantineProvider } from "@mantine/core";
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
  },
});

const isTextEntry = (t: HTMLElement): boolean =>
  (t.tagName === "INPUT" &&
    !["button", "checkbox", "radio", "submit", "reset", "file"].includes((t as HTMLInputElement).type)) ||
  t.tagName === "TEXTAREA" ||
  t.isContentEditable ||
  t.getAttribute("role") === "textbox";

document.addEventListener(
  "mousedown",
  (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (!isTextEntry(t)) e.preventDefault();
  },
  { capture: true },
);

document.addEventListener(
  "focusin",
  (e) => {
    const t = e.target as HTMLElement;
    if (t === document.body) return;
    if (!isTextEntry(t)) t.blur();
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
