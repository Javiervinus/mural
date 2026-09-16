import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConversationCoordinator } from "./app/coordinator";
import { LanguageRegistry } from "./core/languages";
import { TeachingPolicy } from "./core/policy";
import { LearningStore } from "./services/storage";
import { App } from "./ui/App";
import "./app.css";

const root = createRoot(document.getElementById("root")!);
const store = await LearningStore.open();
const coordinator = new ConversationCoordinator(store);
if (import.meta.env.DEV) (window as unknown as { __mural: unknown }).__mural = { coordinator, store, TeachingPolicy, LanguageRegistry };
root.render(
  <StrictMode>
    <App coordinator={coordinator} />
  </StrictMode>,
);
