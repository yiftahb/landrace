/*
 * The shape of the page GitHub answered a 504 with on the tick's list query:
 * styles, markup, a comment and two base64 PNGs, about 40 KB on one line.
 */
const png = `data:image/png;base64,iVBORw0KGgo${"AAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(600)}`;

export const gatewayPage =
  `<!DOCTYPE html><!--\n\nHello future GitHubber! I bet you're here to remove those nasty inline styles,\n-->` +
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Unicorn! &middot; GitHub</title>` +
  `<style type="text/css" media="screen">body { background-color: #f1f1f1; } .container { margin: 50px auto 40px auto; }` +
  `#parallax_wrapper { background: url(${png}) }</style></head><body><div class="container">` +
  `<p><img width="200" height="200" alt="" src="${png}"></p>` +
  `<p><strong>No server is currently available to service your request.</strong></p>` +
  `<p>Sorry about that. Please try refreshing and contact us if the problem persists.</p></div></body></html>`;
