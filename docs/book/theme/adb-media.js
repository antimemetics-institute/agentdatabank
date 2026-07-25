// Scroll-gated playback for the docs' looping clips: a <video autoplay loop muted>
// only actually plays while it's substantially in view — off-screen it sits paused
// at frame 0 instead of burning cycles. `autoplay` stays in the markup as the
// no-JavaScript fallback.
(function () {
  "use strict";

  function init() {
    var videos = document.querySelectorAll("video[autoplay][loop]");
    if (!videos.length || !("IntersectionObserver" in window)) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.intersectionRatio >= 0.4) {
          if (v.paused) { v.currentTime = 0; v.play().catch(function () {}); }
        } else if (!v.paused) {
          v.pause();
        }
      });
    }, { threshold: [0, 0.4] });
    videos.forEach(function (v) {
      v.pause(); // cancel the autoplay; the observer decides
      // belt-and-braces: a looping video never fires `ended`, but if any browser
      // quirk drops the loop, restart manually
      v.addEventListener("ended", function () {
        v.currentTime = 0;
        v.play().catch(function () {});
      });
      // Looping requires SEEKING, and seeking requires HTTP Range support — which
      // dev servers and reverse proxies (code-server) often lack, leaving the video
      // frozen on its last frame after one pass. Playing from a blob: URL makes the
      // clip fully seekable no matter what served it (they're ~200 KB).
      var src = v.getAttribute("src");
      var ready = src
        ? fetch(src).then(function (r) { return r.blob(); }).then(function (b) {
            v.src = URL.createObjectURL(b);
          }).catch(function () {})
        : Promise.resolve();
      ready.then(function () { observer.observe(v); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
