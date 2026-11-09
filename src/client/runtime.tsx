import { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { useMemo, type PropsWithChildren } from "react";

export function AgentRuntimeProvider({ children }: PropsWithChildren) {
  const agent = useMemo(
    () =>
      new HttpAgent({
        url: "/api/agent"
      }),
    []
  );

  const runtime = useAgUiRuntime({
    agent,
    showThinking: false
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
