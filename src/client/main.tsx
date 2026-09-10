import { render } from "preact";
import { App } from "./app";
import { AuthProvider, useAuth } from "./auth-context";
import { LoginPage } from "./components/login";
import { SignContract } from "./components/sign-contract";
import { PublicPay } from "./components/public-pay";
import { EstimateSelection } from "./components/estimate-selection";
import { SignMaintenanceAgreement } from "./components/sign-maintenance-agreement";
import { FollowUpResponse } from "./components/follow-up-response";
import { Refer } from "./components/refer";
import { Unsubscribe } from "./components/unsubscribe";
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
// Phase 13B — same standalone-page precedent as /sign/:token above, for
// the public online-payment link (see public-pay.tsx's own doc comment).
const payMatch = window.location.pathname.match(/^\/pay\/([^/]+)$/);
// Phase 18 — same standalone-page precedent, for the public Good/Better/
// Best estimate comparison/selection link (see estimate-selection.tsx's
// own doc comment).
const estimateMatch = window.location.pathname.match(/^\/estimate\/([^/]+)$/);
// Phase 19B — same standalone-page precedent, for the public Maintenance
// Agreement e-sign link (see sign-maintenance-agreement.tsx's own doc
// comment). Deliberately a distinct path from /sign/:token (Contracts) —
// Maintenance Agreements are a separate parallel domain, not a Contract.
const signMaintenanceMatch = window.location.pathname.match(/^\/sign-maintenance\/([^/]+)$/);
// Phase 19D — same standalone-page precedent, for the public post-job
// follow-up response link and the public referral-landing link.
const followUpMatch = window.location.pathname.match(/^\/follow-up\/([^/]+)$/);
const referMatch = window.location.pathname.match(/^\/refer\/([^/]+)$/);
const unsubscribeMatch = window.location.pathname.match(/^\/unsubscribe\/([^/]+)$/);

render(
  signMatch ? (
    <SignContract token={decodeURIComponent(signMatch[1])} />
  ) : payMatch ? (
    <PublicPay token={decodeURIComponent(payMatch[1])} />
  ) : estimateMatch ? (
    <EstimateSelection token={decodeURIComponent(estimateMatch[1])} />
  ) : signMaintenanceMatch ? (
    <SignMaintenanceAgreement token={decodeURIComponent(signMaintenanceMatch[1])} />
  ) : followUpMatch ? (
    <FollowUpResponse token={decodeURIComponent(followUpMatch[1])} />
  ) : referMatch ? (
    <Refer code={decodeURIComponent(referMatch[1])} />
  ) : unsubscribeMatch ? (
    <Unsubscribe token={decodeURIComponent(unsubscribeMatch[1])} />
  ) : (
    <AuthProvider>
      <Root />
    </AuthProvider>
  ),
  document.getElementById("app")!
);
