import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentRuntimeProvider } from "./runtime";

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
          <section className="agent-thread">
            <Thread />
          </section>
        </main>
      </AgentRuntimeProvider>
    </TooltipProvider>
  );
}
