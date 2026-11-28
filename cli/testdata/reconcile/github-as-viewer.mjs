// A stand-in for GitHub in a test that runs the CLI as a process. It answers
// every request with the login in VIEWER_LOGIN, as GitHub answers the query
// for the owner of a token.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ data: { viewer: { login: process.env.VIEWER_LOGIN } } }), {
    headers: { 'content-type': 'application/json' },
  });
