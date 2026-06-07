/** App root: the auth boundary wrapping the workspace shell. */
import { AuthGate } from "./components/AuthGate.js";
import { Workspace } from "./components/Workspace.js";

export function App(): React.JSX.Element {
  return (
    <AuthGate>
      <Workspace />
    </AuthGate>
  );
}
