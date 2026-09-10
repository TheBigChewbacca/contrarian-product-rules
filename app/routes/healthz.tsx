// Liveness / startup probe for Cloud Run.
//
// Deliberately does not touch Shopify auth or the database: this endpoint
// answers "is the server process up and serving?", not "is every dependency
// healthy?". A Neon cold start must not be able to make Cloud Run tear the
// revision down. Readiness of the database is verified once per release by
// the migrate step in the deploy workflow.

export const loader = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
