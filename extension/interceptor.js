// Runs in the page's MAIN world: patches fetch/XHR so responses the Instagram
// web app receives (likers, comments, story viewers...) can be mirrored to the
// extension's content script via postMessage. No extra requests are made.
(() => {
  const INTERESTING = /\/api\/v1\/(media\/[^/]+\/(likers|comments|list_reel_media_viewer)|feed\/(user|reels_media)|friendships\/[^/]+\/(followers|following))|\/graphql\/query/;

  const post = (payload) => {
    try {
      // always-on trace: filter the page console by "social-circle" to see captures
      console.debug('[social-circle:intercept]', payload.url);
      window.postMessage({ __socialCircle: true, ...payload }, window.location.origin);
    } catch (e) {
      // ignore serialization failures
    }
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const result = origFetch.apply(this, arguments);
    if (INTERESTING.test(url)) {
      const requestBody = typeof init?.body === 'string' ? init.body : null;
      result
        .then((response) => response.clone().text())
        .then((text) => post({ url, requestBody, body: text }))
        .catch(() => {});
    }
    return result;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__scUrl = typeof url === 'string' ? url : String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__scUrl && INTERESTING.test(this.__scUrl)) {
      const requestBody = typeof body === 'string' ? body : null;
      this.addEventListener('load', () => {
        try {
          post({ url: this.__scUrl, requestBody, body: this.responseText });
        } catch (e) {
          // ignore
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
