import { createRoot } from "react-dom/client";
import { App } from "@/app";
import "@/index.css";

import { setDataSource } from "@/lib/data-source";
import { startupSource } from "@/lib/published-source";

startupSource(window.location.href).then((source) => {
  setDataSource(source);
  createRoot(document.getElementById("root")!).render(<App />);
}).catch((error: Error) => {
  const root = document.getElementById("root")!;
  root.setAttribute("role", "alert");
  root.textContent = error.message;
});
