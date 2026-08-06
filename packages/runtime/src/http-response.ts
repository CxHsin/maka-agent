/**
 * A transport that rewrites a response body must not carry over the headers
 * that described the old one. `content-length` becomes a lie the moment the
 * body is re-encoded, and `content-encoding` names a compression that `fetch`
 * has already undone. Both belong to the framing of the response we replaced,
 * not to the one we are handing on.
 */
export function responseWithBody(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
