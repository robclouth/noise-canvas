import "./assets/main.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { Provider } from "jotai";
import { store } from "./store";
import { Toaster } from "./components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
      <Toaster position="bottom-right" />
    </Provider>
  </StrictMode>,
);
