import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentRuntimeProvider } from "./runtime";
import { Tasks } from "./Tasks";

export default function App() {
  return (
    <TooltipProvider>
      <AgentRuntimeProvider>
        <main className="app-shell">
          <header className="app-header">
            <div>
              <p>PRIVATE</p>
              <h1>Personal Agent</h1>
            </div>
          </header>
          <div className="app-content">
            <section className="agent-thread"><Thread /></section>
            <Tasks />
          </div>
        </main>
      </AgentRuntimeProvider>
    </TooltipProvider>
  );
}
