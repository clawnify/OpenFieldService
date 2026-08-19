import { render } from "preact";
import { App } from "./app";
import { AuthProvider, useAuth } from "./auth-context";
import { LoginPage } from "./components/login";
import "./styles.css";

function Root() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div class="loading-text">Loading...</div>;
  }

  return user ? <App /> : <LoginPage />;
}

render(
  <AuthProvider>
    <Root />
  </AuthProvider>,
  document.getElementById("app")!
);
