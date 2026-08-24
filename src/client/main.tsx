import { render } from "preact";
import { App } from "./app";
import { AuthProvider, useAuth } from "./auth-context";
import { LoginPage } from "./components/login";
import { SignContract } from "./components/sign-contract";
import "./styles.css";

function Root() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div class="loading-text">Loading...</div>;
  }

  return user ? <App /> : <LoginPage />;
}

// Phase 13 — the public contract-signing page is deliberately rendered
// OUTSIDE AuthProvider/App entirely (see sign-contract.tsx's own doc
// comment): a signer has no session and the page must work with none.
// Checked before anything auth-related mounts, matching login.tsx's own
// precedent of being a top-level alternative to <App />, not a route
// inside it.
const signMatch = window.location.pathname.match(/^\/sign\/([^/]+)$/);

render(
  signMatch ? (
    <SignContract token={decodeURIComponent(signMatch[1])} />
  ) : (
    <AuthProvider>
      <Root />
    </AuthProvider>
  ),
  document.getElementById("app")!
);
