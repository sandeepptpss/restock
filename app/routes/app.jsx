import { Outlet, useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { describeScope, getMissingScopes } from "../utils/scopes.server";

export const loader = async ({ request }) => {
  const { session, scopes } = await authenticate.admin(request);

  // Checked in the layout so the warning follows the merchant onto every page of
  // the app, not just the one that happens to have failed.
  const missing = await getMissingScopes(session.shop, scopes);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    missingScopes: missing.map((scope) => ({ scope, impact: describeScope(scope) })),
  };
};

/**
 * An app that cannot write inventory cannot restock anything, and until this
 * banner existed the only trace was a FAILED row in the activity log. Shopify is
 * the authority on what was granted, so the check asks it directly and the button
 * sends the merchant to the consent page that fixes it.
 */
function MissingScopesBanner() {
  // Read from the loader rather than taken as a prop: this is the only place it is
  // rendered, and the layout's data is already in scope here.
  const { missingScopes } = useLoaderData();
  const fetcher = useFetcher();
  if (!missingScopes || missingScopes.length === 0) return null;

  const requesting = fetcher.state !== "idle";

  return (
    <div
      style={{
        margin: "16px",
        padding: "16px 20px",
        borderRadius: "10px",
        border: "1px solid #fecaca",
        background: "#fef2f2",
        color: "#7f1d1d",
      }}
    >
      <strong style={{ display: "block", fontSize: "15px", marginBottom: "6px" }}>
        Automations are blocked — this store has not granted the app every permission it needs
      </strong>
      <p style={{ margin: "0 0 10px 0", fontSize: "13px", lineHeight: "1.6" }}>
        Auto-tagging and auto-hiding still run, but anything that writes stock fails and the product
        stays hidden. Missing permission for:
      </p>
      <ul style={{ margin: "0 0 12px 18px", fontSize: "13px", lineHeight: "1.7" }}>
        {missingScopes.map(({ scope, impact }) => (
          <li key={scope}>
            {impact} <code style={{ opacity: 0.7 }}>({scope})</code>
          </li>
        ))}
      </ul>
      <fetcher.Form method="post" action="/app/scopes">
        <input type="hidden" name="scopes" value={missingScopes.map((s) => s.scope).join(",")} />
        <button
          type="submit"
          disabled={requesting}
          style={{
            padding: "8px 16px",
            borderRadius: "8px",
            border: "none",
            background: "#b91c1c",
            color: "#ffffff",
            fontWeight: "700",
            fontSize: "13px",
            cursor: requesting ? "wait" : "pointer",
          }}
        >
          {requesting ? "Opening Shopify…" : "Grant the missing permissions"}
        </button>
      </fetcher.Form>
    </div>
  );
}

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/rules">Automation Rules</s-link>
        <s-link href="/app/inventory">Stock Radar</s-link>
        <s-link href="/app/roi">ROI Analytics</s-link>
        <s-link href="/app/logs">Activity Logs</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plan">Plan</s-link>
      </s-app-nav>
      <MissingScopesBanner />
      <Outlet />
    </AppProvider>

  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
